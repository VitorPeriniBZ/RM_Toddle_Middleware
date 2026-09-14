import type { Job } from 'bullmq';
import { logger } from '@rm-toddle/config';
import { configVersion } from '@rm-toddle/config';
import { abrirRun, fecharRun } from '@rm-toddle/db';
import { FLOW } from '@rm-toddle/queues';
import {
  LeituraDeTurmasQuebrada,
  exigemDecisao,
  reconciliarTurmas,
} from '../../services/reconciliarTurmas';

/**
 * Job de TURMA E DISCIPLINA: RM → de-para.
 *
 * ─── ELE NÃO ESCREVE, E É POR ISSO QUE PODE RODAR SOZINHO ───────────────────
 *
 * O Toddle não tem DELETE de turma, só arquivar. Criar turma automaticamente
 * seria a única ação deste projeto que não dá para desfazer — e a entrada dela
 * é o RM, que abre oferta que nunca é enturmada e que renumera IDTURMADISC a
 * cada cópia de base. Detectar é reversível; criar não é.
 *
 * A deriva que ele acha vira o RESULTADO do run, que a aba Jobs já desenha. Não
 * virou pendência porque `write_pendency` é de pendência de ESCRITA
 * (FREQUENCIA / NOTA / PLANO_AULA, pelo CHECK da migration 010), e esticar o
 * sentido de uma tabela para caber um caso novo é como uma tabela deixa de
 * responder à pergunta para a qual foi feita.
 *
 * ─── DERIVA NÃO DERRUBA; LEITURA QUEBRADA DERRUBA ───────────────────────────
 *
 * Turma nova em começo de semestre é o normal. Um fluxo vermelho por dias ensina
 * a ignorar a cor, e alarme sempre aceso não é alarme.
 *
 * O que derruba é a leitura não valer: zero turma-disciplina vinda do RM, ou
 * nenhuma turma mapeada reconhecida. Nos dois casos "não há deriva" seria
 * mentira — e é exatamente o que alguém concluiria de um verde.
 */
export async function processCourseSync(job: Job): Promise<Record<string, unknown>> {
  const inicio = new Date();
  // O jobId do cron é único por disparo (`repeat:courses.sync:<millis>`), então
  // serve de chave de run sem sufixo de hora. Ver a guarda em
  // packages/db/src/chaveDeRunPorExecucao.test.ts.
  const chave = job.id ?? `courses-${inicio.getTime()}`;

  const runId = await abrirRun({
    tipo: FLOW.TURMAS,
    chave,
    inicio,
    configVersion: configVersion(),
    payload: { jobId: job.id, trigger: job.name },
  });

  let relatorio;
  try {
    relatorio = await reconciliarTurmas();
  } catch (e) {
    if (e instanceof LeituraDeTurmasQuebrada) {
      /*
       * Leitura quebrada fecha o run como `failed` e NÃO lança.
       *
       * Lançar faria o BullMQ retentar três vezes e mandar para a DLQ — e nada
       * disto se resolve retentando: credencial expirada, filial errada e
       * de-para defasado depois de cópia de base precisam de gente. Retentar só
       * transformaria um diagnóstico claro em três linhas iguais na DLQ.
       */
      await fecharRun(runId, 'failed', {
        leituraQuebrada: e.message,
        comoResolver: e.comoResolver,
      });
      logger.error({ jobId: job.id, err: e.message, comoResolver: e.comoResolver },
        'Reconciliação de turmas: a LEITURA está quebrada — "sem deriva" seria mentira');
      return { leituraQuebrada: e.message, comoResolver: e.comoResolver };
    }
    await fecharRun(runId, 'failed', { erro: e instanceof Error ? e.message : String(e) });
    throw e;
  }

  const decisao = exigemDecisao(relatorio);

  /*
   * Contabilidade fechada: o que foi lido do período tem de ser igual à soma do
   * que foi classificado. `SUMIU_DO_RM` sai da conta porque não veio da leitura
   * do RM — veio do de-para, do outro lado da comparação.
   */
  const classificadas = relatorio.achados.filter((a) => a.situacao !== 'SUMIU_DO_RM').length;
  const naoClassificadas = relatorio.doPeriodoCorrente - classificadas;

  const resultado = {
    idPerlet: relatorio.idPerlet,
    lidasDoRm: relatorio.lidasDoRm,
    doPeriodoCorrente: relatorio.doPeriodoCorrente,
    mapeadasAtivas: relatorio.mapeadasAtivas,
    mapeadasArquivadas: relatorio.mapeadasArquivadas,
    porSituacao: relatorio.porSituacao,
    exigemDecisao: decisao.length,
    // A lista, e não só o número: "3 turmas novas" sem dizer QUAIS obriga a
    // abrir um terminal para descobrir, e ninguém abre.
    itens: decisao.slice(0, 20).map((a) => ({
      situacao: a.situacao,
      idTurmaDisc: a.idTurmaDisc,
      turma: a.codTurma,
      disciplina: a.codDisc ? `${a.codDisc} ${a.nomeDisc ?? ''}`.trim() : undefined,
      alunosComNota: a.alunos,
      criadaEm: a.criadoEm,
    })),
    itensOmitidos: Math.max(0, decisao.length - 20),
    renomeadas: relatorio.renomeadas.length,
    /*
     * Duas honestidades que o relatório precisa carregar:
     *
     * `semSinalDeAlunos` porque, sem ele, "NOVA_SEM_ALUNOS" vira afirmação sem
     * base — e é justamente a categoria que manda ignorar.
     *
     * `naoClassificadas` porque diferente de zero significa que a classificação
     * perdeu linha pelo caminho, e ninguém perceberia olhando só os totais.
     */
    semSinalDeAlunos: relatorio.semSinalDeAlunos,
    naoClassificadas,
  };

  if (naoClassificadas !== 0) {
    await fecharRun(runId, 'failed', { ...resultado, contabilidadeNaoFecha: true });
    logger.error({ jobId: job.id, ...resultado, contabilidadeNaoFecha: true },
      'Reconciliação de turmas: a conta não fecha — lidas ≠ classificadas');
    return { ...resultado, contabilidadeNaoFecha: true };
  }

  await fecharRun(runId, 'succeeded', resultado);

  if (decisao.length > 0) {
    logger.warn({ jobId: job.id, exigemDecisao: decisao.length, itens: resultado.itens },
      'Deriva de turma-disciplina DETECTADA — criar turma no Toddle é irreversível, então nada foi feito');
  } else {
    logger.info({ jobId: job.id, ...resultado }, 'Turma-disciplina sem deriva que exija decisão');
  }

  return resultado;
}
