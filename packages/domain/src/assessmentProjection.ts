import { logger } from '@rm-toddle/config';
import { janelaCompativel, type EtapaNotaRm, type JanelaToddle } from './gradeProjection';
import {
  chaveNaturalNotaAvaliacao,
  type NotaParaEscrever,
  type ProvaParaCriar,
} from './provaXml';
import type { RmAssessmentTargets } from './rmAssessmentTargets';
import type { ToddleAvaliacao, ToddleNotaAvaliacao } from './toddleAssessmentSource';

/**
 * Projeta a nota de avaliação do Toddle no que o RM aceitaria.
 *
 * Diferente da projeção de nota de etapa, esta tem DOIS destinos: a avaliação
 * (`SProvas`) e a nota dela (`SNotas`). A avaliação pode não existir ainda no
 * RM — e criá-la é escrever ESTRUTURA acadêmica, não só valor. Por isso ela sai
 * separada no relatório, para quem opera ver o que vai ser criado antes de
 * autorizar.
 */

export type MotivoRecusaAvaliacao =
  /** O tipo do assignment não está em `NOTA_TIPOS_ELEGIVEIS`. */
  | 'TIPO_NAO_ELEGIVEL'
  /** Assignment arquivado no Toddle. */
  | 'AVALIACAO_ARQUIVADA'
  /** O resultado aponta para um assignment que não veio na leitura. */
  | 'AVALIACAO_DESCONHECIDA'
  /** O assignment não tem `classId`, ou o classId não tem de-para COURSE. */
  | 'TURMA_NAO_MAPEADA'
  | 'ALUNO_NAO_MAPEADO'
  | 'ETAPA_NAO_MAPEADA'
  /** A etapa não existe no RM para essa turma-disciplina, ou não aceita digitação. */
  | 'ETAPA_NAO_GRAVAVEL'
  /** `SETAPAS.DISPONIVELALUNOS='N'` e a política exige liberação. */
  | 'ETAPA_NAO_LIBERADA'
  /** O ordinal do de-para de etapa aponta para a etapa errada nesta data. */
  | 'JANELA_INCOMPATIVEL'
  /** A nota é maior que o `maxScore` da própria avaliação. */
  | 'NOTA_ACIMA_DO_MAXIMO'
  /** Sem `maxScore`: sem ele não há `SProvas.VALOR`, e a nota fica sem escala. */
  | 'SEM_MAXIMO';

export interface ProjetadoAvaliacao {
  linha: NotaParaEscrever;
  chaveRm: string;
  origemId: string;
  origem: ToddleNotaAvaliacao;
  /** `true` quando a avaliação ainda não existe no RM e vai ser criada. */
  provaNova: boolean;
}

export interface RecusadoAvaliacao {
  motivo: MotivoRecusaAvaliacao;
  detalhe: string;
  origemId: string;
  origem: ToddleNotaAvaliacao;
}

/** Uma avaliação a criar, com o assignment que a originou. */
export interface ProvaPendente extends ProvaParaCriar {
  assignmentId: string;
  /** `IDTURMADISC:CODETAPA:CODPROVA` — o `rm_code` do de-para ASSESSMENT. */
  rmCode: string;
}

export interface ContextoProjecaoAvaliacao {
  codColigada: string;
  alunoParaRa: Map<string, string>;
  cursoParaTurmaDisc: Map<string, string>;
  periodoParaEtapa: Map<string, string>;
  janelaDoPeriodo: Map<string, JanelaToddle>;
  etapasRm: Map<string, EtapaNotaRm>;
  alvos: RmAssessmentTargets;
  /** `assignmentId` -> `IDTURMADISC:CODETAPA:CODPROVA` já mapeado. */
  avaliacaoMapeada: Map<string, string>;
  /** Prefixos de `assessmentType` que valem como nota. */
  tiposElegiveis: string[];
  dataReferencia: string;
  exigirEtapaLiberada: boolean;
}

export interface ResumoProjecaoAvaliacao {
  projetados: ProjetadoAvaliacao[];
  recusados: RecusadoAvaliacao[];
  porMotivo: Record<string, number>;
  /** Avaliações que precisam ser CRIADAS no RM antes de a nota caber. */
  provasACriar: ProvaPendente[];
  /** Duas notas do Toddle no mesmo destino do RM, com valores diferentes. */
  colisoes: string[];
}

export function projetaLoteAvaliacoes(
  avaliacoes: ToddleAvaliacao[],
  notas: ToddleNotaAvaliacao[],
  ctx: ContextoProjecaoAvaliacao,
): ResumoProjecaoAvaliacao {
  const porId = new Map(avaliacoes.map((a) => [a.assignmentId, a]));
  const projetados: ProjetadoAvaliacao[] = [];
  const recusados: RecusadoAvaliacao[] = [];
  const porMotivo: Record<string, number> = {};
  const provasACriar: ProvaPendente[] = [];

  // Alocação de CODPROVA dentro desta passada: duas avaliações novas na mesma
  // etapa não podem receber o mesmo número. O contador começa no que o RM já tem
  // e avança conforme decidimos criar.
  const proximo = new Map<string, number>();
  const codProvaDe = new Map<string, string>(); // assignmentId -> codProva desta passada

  const recusa = (
    n: ToddleNotaAvaliacao,
    motivo: MotivoRecusaAvaliacao,
    detalhe: string,
  ): void => {
    recusados.push({ motivo, detalhe, origemId: n.origemId, origem: n });
    porMotivo[motivo] = (porMotivo[motivo] ?? 0) + 1;
  };

  for (const n of notas) {
    const av = porId.get(n.assignmentId);
    if (!av) {
      recusa(n, 'AVALIACAO_DESCONHECIDA', `assignment ${n.assignmentId} não veio na leitura`);
      continue;
    }
    if (av.arquivado) {
      recusa(n, 'AVALIACAO_ARQUIVADA', `"${av.titulo}" está ARCHIVED no Toddle`);
      continue;
    }
    if (!ctx.tiposElegiveis.some((t) => av.tipo.startsWith(t))) {
      recusa(
        n,
        'TIPO_NAO_ELEGIVEL',
        `tipo "${av.tipo}" fora de NOTA_TIPOS_ELEGIVEIS (${ctx.tiposElegiveis.join(',')})`,
      );
      continue;
    }

    const idTurmaDisc = av.classId ? ctx.cursoParaTurmaDisc.get(av.classId) : undefined;
    if (!idTurmaDisc) {
      recusa(
        n,
        'TURMA_NAO_MAPEADA',
        `classId=${av.classId ?? '(ausente)'} sem de-para COURSE ativo`,
      );
      continue;
    }

    const ra = ctx.alunoParaRa.get(n.studentId);
    if (!ra) {
      recusa(n, 'ALUNO_NAO_MAPEADO', `studentId ${n.studentId} sem de-para STUDENT ativo`);
      continue;
    }

    const codEtapa = ctx.periodoParaEtapa.get(n.gradingPeriodId);
    if (!codEtapa) {
      recusa(
        n,
        'ETAPA_NAO_MAPEADA',
        `academicTermId ${n.gradingPeriodId} sem de-para GRADING_PERIOD ativo`,
      );
      continue;
    }

    const etapa = ctx.etapasRm.get(`${idTurmaDisc}|${codEtapa}`);
    if (!etapa) {
      recusa(n, 'ETAPA_NAO_GRAVAVEL', `IDTURMADISC ${idTurmaDisc} sem etapa ${codEtapa} de nota`);
      continue;
    }
    if (!etapa.permiteDigitacao) {
      recusa(
        n,
        'ETAPA_NAO_GRAVAVEL',
        `etapa ${codEtapa} de ${idTurmaDisc} não permite digitação (PERMITEDIGITACAO≠S)`,
      );
      continue;
    }
    if (ctx.exigirEtapaLiberada && !etapa.disponivelAlunos) {
      recusa(n, 'ETAPA_NAO_LIBERADA', `etapa ${codEtapa} com DISPONIVELALUNOS='N'`);
      continue;
    }

    const janela = janelaCompativel(
      ctx.dataReferencia,
      etapa,
      ctx.janelaDoPeriodo.get(n.gradingPeriodId),
    );
    if (!janela.ok) {
      recusa(n, 'JANELA_INCOMPATIVEL', janela.porque);
      continue;
    }

    if (n.maximo === null) {
      recusa(
        n,
        'SEM_MAXIMO',
        'o resultado veio sem maxScore — sem ele não há SProvas.VALOR e a nota fica sem escala',
      );
      continue;
    }
    if (n.valor > n.maximo) {
      recusa(n, 'NOTA_ACIMA_DO_MAXIMO', `nota ${n.valor} acima do máximo ${n.maximo}`);
      continue;
    }

    // ─── a avaliação existe no RM? ──────────────────────────────────────────
    let codProva = codProvaDe.get(n.assignmentId);
    let provaNova = false;

    if (!codProva) {
      const mapeada = ctx.avaliacaoMapeada.get(n.assignmentId);
      if (mapeada) {
        // Já mapeada. A chave é IDTURMADISC:CODETAPA:CODPROVA, e conferimos que
        // a turma e a etapa continuam as mesmas: um assignment que trocou de
        // turma no Toddle apontaria para a prova errada.
        const [tdMap, etapaMap, provaMap] = mapeada.split(':');
        if (tdMap !== idTurmaDisc || etapaMap !== codEtapa) {
          recusa(
            n,
            'AVALIACAO_DESCONHECIDA',
            `de-para ASSESSMENT aponta para ${mapeada}, mas o assignment está em ` +
              `${idTurmaDisc}:${codEtapa} agora — o vínculo mudou e precisa de revisão`,
          );
          continue;
        }
        codProva = provaMap;
      } else {
        // Não mapeada. Antes de criar, procura por DESCRIÇÃO: se um humano já
        // criou uma prova com o mesmo título, adotamos a dele em vez de criar
        // uma segunda ao lado.
        const porDescricao = ctx.alvos.descricoesDe(idTurmaDisc, codEtapa);
        const existente = porDescricao.get(av.titulo.slice(0, 100).trim());
        if (existente) {
          codProva = existente;
        } else {
          const chaveEtapa = `${idTurmaDisc}|${codEtapa}`;
          const seq =
            proximo.get(chaveEtapa) ?? ctx.alvos.proximoCodProva(idTurmaDisc, codEtapa);
          proximo.set(chaveEtapa, seq + 1);
          codProva = String(seq);
          provaNova = true;
          provasACriar.push({
            assignmentId: n.assignmentId,
            rmCode: `${idTurmaDisc}:${codEtapa}:${codProva}`,
            codColigada: ctx.codColigada,
            idTurmaDisc,
            codEtapa,
            codProva,
            descricao: av.titulo,
            valor: n.maximo,
          });
        }
      }
      codProvaDe.set(n.assignmentId, codProva);
    } else {
      provaNova = provasACriar.some((p) => p.assignmentId === n.assignmentId);
    }

    const linha: NotaParaEscrever = {
      codColigada: ctx.codColigada,
      codProva,
      codEtapa,
      idTurmaDisc,
      ra,
      nota: n.valor,
    };

    projetados.push({
      linha,
      chaveRm: chaveNaturalNotaAvaliacao(linha),
      origemId: n.origemId,
      origem: n,
      provaNova,
    });
  }

  const porChave = new Map<string, Set<number>>();
  for (const p of projetados) {
    const atual = porChave.get(p.chaveRm);
    if (atual) atual.add(p.linha.nota);
    else porChave.set(p.chaveRm, new Set([p.linha.nota]));
  }
  const colisoes = [...porChave.entries()].filter(([, v]) => v.size > 1).map(([k]) => k);

  logger.info(
    {
      notasLidas: notas.length,
      projetadas: projetados.length,
      recusadas: recusados.length,
      porMotivo,
      provasACriar: provasACriar.length,
      colisoes: colisoes.length,
    },
    'Projeção de notas de avaliação concluída',
  );

  return { projetados, recusados, porMotivo, provasACriar, colisoes };
}
