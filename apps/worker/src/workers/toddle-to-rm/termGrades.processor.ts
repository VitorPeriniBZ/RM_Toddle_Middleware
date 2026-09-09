import type { Job } from 'bullmq';
import { env, heartbeat, logger } from '@rm-toddle/config';
import { sincronizarNotas } from '../../services/sincronizarNotas';

/**
 * Job da via de NOTA: Toddle -> TOTVS RM.
 *
 * É a PRIMEIRA e ÚNICA escrita agendada que este projeto faz no RM. Todas as
 * outras exigem alguém digitando `--executar`. Por isso ele carrega três coisas
 * que os jobs de cadastro não precisam.
 *
 * ─── 1. INTERRUPTOR ─────────────────────────────────────────────────────────
 *
 * `NOTA_SYNC_ATIVO` é checado aqui DE NOVO, mesmo com o scheduler já sendo
 * removido quando a flag cai. Cinto e suspensório de propósito: um job pode
 * estar na fila desde antes do desligamento, e um job enfileirado não sabe que
 * a escola mudou de ideia nos últimos 30 minutos.
 *
 * ─── 2. FALHA DE INTEGRIDADE NÃO É RETENTADA ────────────────────────────────
 *
 * Se a releitura achar nota divergente, ausente, ou se algum envio ficou sem
 * resposta, o job NÃO lança. Lançar faria o BullMQ retentar, e retentar uma
 * escrita que PODE ter sido aplicada é escrever duas vezes de olhos fechados —
 * exatamente o que o `SaveRecord` sem resposta já deixa ambíguo.
 *
 * O caso fica visível por três caminhos que não envolvem reenviar: o run fecha
 * como `failed` (`npm run runs`), o heartbeat vai como falha (alerta externo) e
 * o log sai em nível de erro. Erro que se resolve reenviando lança; erro que
 * exige um humano ler o RM, não.
 *
 * Exceção de verdade — RM fora do ar, Toddle recusando, rede — essa SOBE, e aí
 * o retry e a DLQ fazem sentido.
 *
 * ─── 3. O GATE DE VOLUME PODE PARAR O JOB, E ISSO É SUCESSO ─────────────────
 *
 * `PRECISA_APROVACAO` significa que o plano é grande demais para rodar sozinho —
 * tipicamente a PRIMEIRA passada, que vê todas as notas já lançadas de uma vez.
 * O job registra o pedido e termina OK: não escreveu, mas fez o que devia.
 * Alguém aprova com `npm run aprovar` e a próxima passada executa.
 */
export async function processTermGradesSync(job: Job): Promise<Record<string, unknown>> {
  if (!env.NOTA_SYNC_ATIVO) {
    logger.warn(
      { jobId: job.id },
      'Via de nota DESLIGADA (NOTA_SYNC_ATIVO=false) — job encerrado sem tocar o RM',
    );
    return { desligado: true };
  }

  const r = await sincronizarNotas({ executar: true, quem: 'cron' });

  const comum = {
    jobId: job.id,
    chaveRun: r.chaveRun,
    notasNoToddle: r.origem.notas.length,
    projetaveis: r.projecao.projetados.length,
    recusadasNaProjecao: r.projecao.recusados.length,
    porMotivo: r.projecao.porMotivo,
    aEscrever: r.decisoes.aEscrever,
    pendenciasAbertas: r.pendenciasAbertasNestaPassada,
    filaAberta: r.filaAberta,
    teto: r.volume.veredito,
  };

  if (r.naoEscreveu) {
    // Nenhum destes é falha: são as guardas fazendo o trabalho delas.
    const nivel = r.naoEscreveu === 'recusado-pelo-teto' ? 'error' : 'info';
    logger[nivel](
      { ...comum, naoEscreveu: r.naoEscreveu, motivosDoTeto: r.volume.motivos },
      r.naoEscreveu === 'nada-a-escrever'
        ? 'Via de nota: nada mudou no Toddle'
        : `Via de nota: NÃO escreveu (${r.naoEscreveu})`,
    );
    // Teto RECUSADO é o único que merece alerta: significa escopo suspeito.
    await heartbeat.notas(r.naoEscreveu === 'recusado-pelo-teto' ? 'falha' : 'sucesso', comum);
    return { ...comum, naoEscreveu: r.naoEscreveu };
  }

  const e = r.escrita;
  if (!e) return comum;

  const integridadeOk = e.divergentes.length === 0 && e.ausentes.length === 0 && e.desconhecidas.length === 0;

  const resultado = {
    ...comum,
    enviadas: e.enviadas,
    conferidas: e.conferidas,
    divergentes: e.divergentes.length,
    ausentes: e.ausentes.length,
    recusadasPeloRm: e.recusadas.length,
    semResposta: e.desconhecidas.length,
    chamadas: e.chamadas,
  };

  if (!integridadeOk) {
    logger.error(
      { ...resultado, exemplosDivergentes: e.divergentes.slice(0, 5), exemplosAusentes: e.ausentes.slice(0, 5) },
      'Via de nota: escrita com DIVERGÊNCIA — NÃO será retentada. Releia o RM antes de rodar de novo',
    );
    await heartbeat.notas('falha', resultado);
    return resultado;
  }

  logger.info(resultado, 'Via de nota: escrita conferida');
  await heartbeat.notas('sucesso', resultado);
  return resultado;
}
