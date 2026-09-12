import { Job } from 'bullmq';
import {
  closeAllQueues,
  defaultJobOptions,
  deadLetterQueue,
  FLUXOS_EM_ORDEM,
  getQueue,
} from '@rm-toddle/queues';
import { DeadLetterPayload } from '@rm-toddle/queues';
import { redisConnection } from '@rm-toddle/queues';
import { logger } from '@rm-toddle/config';

/**
 * Reprocessamento MANUAL da Dead Letter Queue (requisito de resiliência).
 *
 * Uso:
 *   npm run dlq -- list                  # lista jobs mortos
 *   npm run dlq -- reprocess <dlqJobId>  # devolve um job à fila de origem
 *   npm run dlq -- reprocess --all       # devolve todos
 *   npm run dlq -- remove <dlqJobId>     # DESCARTA um job, sem reprocessar
 *   npm run dlq -- podar                 # aplica a retenção declarada às falhas
 *
 * `remove` existe para o caso "a causa já foi corrigida e reprocessar seria
 * redundante" — sem ele, entrada obsoleta fica na DLQ para sempre e treina o
 * time a ignorar a lista, que é justamente onde os erros de verdade aparecem.
 * Ele DESCARTA dado: registra o payload no log antes de apagar, para o motivo
 * não se perder junto. Não tem `--all` de propósito — descarte em massa é como
 * se perde uma falha real no meio.
 *
 * ─── `podar` É OUTRA COISA, E NÃO CONTRADIZ O PARÁGRAFO ACIMA ───────────────
 *
 * `remove` mexe na DLQ — a fila dedicada, onde cada entrada é um trabalho que
 * alguém precisa decidir o que fazer. Descartar em massa ali perderia decisão.
 *
 * `podar` mexe no conjunto `failed` de cada fila do BullMQ, que é só o registro
 * das últimas falhas. A política de retenção dele JÁ ESTÁ DECLARADA em
 * `queues.ts`: `removeOnFail: { age: 7 dias }`. O problema é que o BullMQ poda
 * PREGUIÇOSAMENTE, quando um job novo daquela fila falha — então uma fila que
 * voltou a funcionar guarda as falhas velhas para sempre.
 *
 * Medido em 12/09/2026: 29 falhas de `rm-to-toddle.staff` com ~25 dias, todas de
 * um agendador (`staff-sync-nightly`) que não existe mais, de três causas já
 * resolvidas (senha do RM expirada, banco do RM fora do ar, Sentença sem
 * permissão). O fluxo tinha 16 sucessos seguidos e o painel continuava marcando
 * 29 falhas — que é como se ensina um time a ignorar o painel.
 *
 * Por isso este comando não escolhe nada: ele aplica a idade que já está
 * escrita. Não há número novo a decidir aqui, e mudar a retenção se faz em
 * `queues.ts`, num lugar só.
 */
async function listDlq(): Promise<Job<DeadLetterPayload>[]> {
  return deadLetterQueue.getJobs(['waiting', 'delayed', 'paused'], 0, 200) as Promise<
    Job<DeadLetterPayload>[]
  >;
}

async function reprocess(job: Job<DeadLetterPayload>): Promise<void> {
  const p = job.data;
  await getQueue(p.sourceQueue).add(p.jobName, p.data);
  await job.remove();
  logger.info(
    { dlqJobId: job.id, sourceQueue: p.sourceQueue, jobName: p.jobName },
    'Job devolvido à fila de origem',
  );
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);

  if (command === 'list') {
    const jobs = await listDlq();
    if (jobs.length === 0) {
      logger.info('DLQ vazia 🎉');
    }
    for (const job of jobs) {
      const p = job.data;
      logger.info(
        {
          dlqJobId: job.id,
          sourceQueue: p.sourceQueue,
          jobName: p.jobName,
          failedAt: p.failedAt,
          attemptsMade: p.attemptsMade,
          failedReason: p.failedReason,
        },
        'Job na DLQ',
      );
    }
  } else if (command === 'reprocess' && arg === '--all') {
    const jobs = await listDlq();
    for (const job of jobs) await reprocess(job);
    logger.info({ total: jobs.length }, 'Reprocessamento em massa concluído');
  } else if (command === 'reprocess' && arg) {
    const job = (await deadLetterQueue.getJob(arg)) as Job<DeadLetterPayload> | undefined;
    if (!job) {
      logger.error({ dlqJobId: arg }, 'Job não encontrado na DLQ');
      process.exitCode = 1;
    } else {
      await reprocess(job);
    }
  } else if (command === 'remove' && arg) {
    const job = (await deadLetterQueue.getJob(arg)) as Job<DeadLetterPayload> | undefined;
    if (!job) {
      logger.error({ dlqJobId: arg }, 'Job não encontrado na DLQ');
      process.exitCode = 1;
    } else {
      const p = job.data;
      // Log ANTES de apagar: o descarte não pode levar o motivo com ele.
      logger.warn(
        {
          dlqJobId: job.id,
          sourceQueue: p.sourceQueue,
          jobName: p.jobName,
          failedAt: p.failedAt,
          attemptsMade: p.attemptsMade,
          failedReason: p.failedReason,
          data: p.data,
        },
        'Job DESCARTADO da DLQ sem reprocessar',
      );
      await job.remove();
    }
  } else if (command === 'podar') {
    // A idade vem da política declarada, não de um argumento: um comando que
    // aceita "poda tudo acima de N" convida a escolher N até a lista esvaziar.
    const idadeMs = (defaultJobOptions.removeOnFail as { age: number }).age * 1_000;
    const dias = Math.round(idadeMs / 86_400_000);
    let total = 0;

    for (const fluxo of FLUXOS_EM_ORDEM) {
      const fila = getQueue(fluxo.fila);
      // O `clean` do BullMQ remove o job inteiro (hash e índice), ao contrário
      // de apagar a chave do conjunto na mão, que deixaria o hash órfão.
      const podados = await fila.clean(idadeMs, 1_000, 'failed');
      if (podados.length > 0) {
        logger.warn(
          { fila: fluxo.fila, fluxo: fluxo.key, podados: podados.length, ids: podados },
          `Falhas mais velhas que ${dias} dias removidas do registro da fila`,
        );
        total += podados.length;
      }
    }

    if (total === 0) logger.info({ dias }, 'Nada a podar — nenhuma falha acima da retenção');
    else logger.info({ total, dias }, 'Poda concluída (a DLQ não foi tocada)');
  } else {
    logger.info(
      'Uso: npm run dlq -- list | reprocess <dlqJobId> | reprocess --all | remove <dlqJobId> | podar',
    );
  }

  await closeAllQueues();
  await redisConnection.quit();
}

main().catch((error) => {
  logger.error({ error }, 'Falha no comando de DLQ');
  process.exit(1);
});
