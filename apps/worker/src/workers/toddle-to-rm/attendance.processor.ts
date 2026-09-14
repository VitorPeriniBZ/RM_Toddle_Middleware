import type { Job } from 'bullmq';
import { env, logger } from '@rm-toddle/config';
import { sincronizarFrequencia } from '../../services/sincronizarFrequencia';

/**
 * Job da via de FREQUÊNCIA: Toddle -> TOTVS RM.
 *
 * A SEGUNDA escrita agendada em registro acadêmico, e a mais delicada das duas.
 *
 * ─── POR QUE MAIS DELICADA QUE A NOTA ───────────────────────────────────────
 *
 * O TOTVS é a fonte de verdade da frequência e já tem ~14,6 mil faltas lançadas
 * à mão. Uma nota escrita por cima de outra é visível; uma AUSÊNCIA apagada não
 * é — a `SFREQUENCIA` guarda falta, e `PRESENCA='P'` não cria linha, REMOVE a
 * que houver. Escrever "presente" por engano apaga a falta que um professor
 * lançou, sem deixar rastro no RM.
 *
 * É por isso que `decidirEscrita` existe, e por isso o default de
 * `FREQ_SYNC_ATIVO` é `false`.
 *
 * ─── 1. INTERRUPTOR, CONFERIDO DE NOVO AQUI ─────────────────────────────────
 *
 * Cinto e suspensório, como na via de nota: um job pode estar na fila desde
 * antes do desligamento, e um job enfileirado não sabe que a escola mudou de
 * ideia.
 *
 * ─── 2. A JANELA É FIXA, NÃO "DESDE A ÚLTIMA VEZ" ───────────────────────────
 *
 * `FREQ_SYNC_DIAS` dias para trás, sempre. Isso torna cada passada idempotente e
 * independente do histórico: perder uma noite não perde dado, porque a noite
 * seguinte cobre o mesmo intervalo. "Desde a última vez" precisaria de um
 * marcador durável cuja perda seria silenciosa — e um marcador errado significa
 * frequência que nunca chega.
 *
 * ─── 3. FALHA DE INTEGRIDADE NÃO É RETENTADA ────────────────────────────────
 *
 * Igual à nota: se a releitura não achar a ausência, ou se houver linha sem
 * resposta, o job NÃO lança. Lançar faria o BullMQ retentar, e retentar uma
 * escrita que PODE ter sido aplicada é escrever duas vezes de olhos fechados.
 * O caso fica visível pelo run `failed`, pelo log de erro e pela fila de
 * pendências. Exceção de verdade — RM fora do ar, Toddle recusando, rede — essa
 * SOBE, e aí retry e DLQ fazem sentido.
 */
export async function processAttendanceSync(job: Job): Promise<Record<string, unknown>> {
  if (!env.FREQ_SYNC_ATIVO) {
    logger.warn(
      { jobId: job.id },
      'Via de frequência DESLIGADA (FREQ_SYNC_ATIVO=false) — job encerrado sem tocar o RM',
    );
    return { desligado: true };
  }

  const hoje = new Date();
  const inicioDaJanela = new Date(hoje);
  inicioDaJanela.setDate(hoje.getDate() - (env.FREQ_SYNC_DIAS - 1));
  const iso = (d: Date): string => d.toISOString().slice(0, 10);

  const r = await sincronizarFrequencia({
    de: iso(inicioDaJanela),
    ate: iso(hoje),
    executar: true,
    quem: `job:${job.name}`,
    // O `.catch` não é zelo: sem ele, uma queda do Redis no meio do job faria o
    // erro do progresso sumir, a barra travaria na tela e quem olhasse não
    // saberia se o job morreu ou só parou de reportar.
    aoProgredir: (pr) => void job.updateProgress(pr).catch(() => undefined),
  });

  // ─── não escreveu: cada motivo é um desfecho legítimo ─────────────────────
  if (!r.escrita) {
    const resumo = {
      naoEscreveu: r.naoEscreveu,
      janela: r.janela,
      lidosDoToddle: r.lidosDoToddle,
      projetaveis: r.projetaveis,
      aEscrever: r.aEscrever,
      pendencias: r.pendenciasDeDecisao,
      filaAberta: r.filaDePendencias.abertas,
    };
    if (r.naoEscreveu === 'recusado-pelo-teto') {
      logger.error({ jobId: job.id, ...resumo, motivos: r.volume.motivos },
        'Frequência RECUSADA pelo teto de volume — isto não é para aprovar, é para investigar');
    } else if (r.naoEscreveu === 'precisa-aprovacao') {
      logger.warn({ jobId: job.id, ...resumo, chave: r.chaveDeAprovacao },
        'Frequência parada no gate de aprovação — libere com `npm run aprovar`');
    } else {
      logger.info({ jobId: job.id, ...resumo }, 'Frequência: nada a escrever nesta passada');
    }
    return resumo;
  }

  const e = r.envio;
  const resultado = { janela: r.janela, ...e };

  if (!e?.ok) {
    // Ver "3. falha de integridade" no cabeçalho: NÃO lança.
    logger.error({ jobId: job.id, ...resultado },
      'Frequência: o run não fechou limpo — há linha sem resposta ou ausência que a releitura não achou');
  } else if (e.recusadas > 0) {
    logger.warn({ jobId: job.id, ...resultado },
      'Frequência PARCIAL — o que o RM recusou virou pendência, com a resposta dele');
  } else {
    logger.info({ jobId: job.id, ...resultado }, 'Frequência escrita no RM e conferida por releitura');
  }

  return resultado;
}
