import { closeAllQueues, redisConnection, FLUXOS_EM_ORDEM } from '@rm-toddle/queues';
import { listarAgenda, pgPool } from '@rm-toddle/db';
import { logger } from '@rm-toddle/config';
import { reconcileSchedulers, semearDoAmbiente } from '../agenda/reconciliar';

/**
 * Semeia a agenda (se ainda não existir) e reconcilia o Redis com ela.
 * Uso: npm run schedule
 *
 * ─── O QUE MUDOU AQUI, E POR QUE IMPORTA ────────────────────────────────────
 *
 * Este script LIA O AMBIENTE e registrava os schedulers a partir dele. Não pode
 * mais: enquanto o `init` de cada deploy carregar o cron do `.env`, a tela de
 * agendamento não é fonte de verdade de nada — o deploy seguinte desfaria em
 * silêncio o que alguém mudou pela tela, e a tela continuaria mostrando o valor
 * novo. Agora ele lê o BANCO (`flow_schedule`, migration 016).
 *
 * O ambiente sobrevive como SEMENTE, uma vez por fluxo: `semearDoAmbiente()` usa
 * `ON CONFLICT DO NOTHING`, então só preenche o que ainda não existe.
 *
 * ─── POR QUE CONTINUA MORANDO NO `init` DO DEPLOY ───────────────────────────
 *
 * Porque o worker também reconcilia, mas o `init` roda ANTES dele e garante que a
 * primeira reconciliação já aconteceu quando o worker sobe — inclusive a
 * varredura dos schedulers órfãos com os ids antigos. E porque "uma vez, à mão,
 * alguém lembra" é exatamente como um cron deixa de existir sem dar erro nenhum.
 *
 * É idempotente: a semente não sobrescreve e a reconciliação é upsert por id.
 */
async function main(): Promise<void> {
  const semeados = await semearDoAmbiente();
  const resultado = await reconcileSchedulers('npm run schedule');

  if (resultado === 'ocupado') {
    // Outro processo (o worker) está reconciliando agora. Não é erro: ele lê a
    // mesma tabela e aplica a mesma revisão.
    logger.info('Reconciliação já em curso em outro processo — nada a fazer aqui');
  }

  const agenda = await listarAgenda();
  logger.info(
    {
      semeados,
      aplicados: resultado === 'ocupado' ? [] : resultado.aplicados,
      removidos: resultado === 'ocupado' ? [] : resultado.removidos,
      orfaosRemovidos: resultado === 'ocupado' ? [] : resultado.orfaosRemovidos,
      agenda: agenda.map((a) => ({
        fluxo: a.flowKey,
        cron: a.cron,
        ativo: a.ativo,
        revisao: a.revisao,
        aplicada: a.revisaoAplicada,
      })),
      fluxosSemLinha: FLUXOS_EM_ORDEM
        .filter((f) => !agenda.some((a) => a.flowKey === f.key))
        .map((f) => f.key),
    },
    'Agenda em vigor (fonte: tabela flow_schedule — o .env é só semente)',
  );

  await closeAllQueues();
  await redisConnection.quit();
  await pgPool.end();
}

main().catch((error) => {
  logger.error({ error }, 'Falha ao reconciliar a agenda');
  process.exit(1);
});
