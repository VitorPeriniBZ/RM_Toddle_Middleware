import { logger } from '@rm-toddle/config';
import { notaParaRm, TIPOETAPA_NOTA } from './notaXml';
import type { ToddleNota } from './toddleGradeSource';

/**
 * Projeta a nota do Toddle no que o RM aceitaria — e RECUSA, com motivo, tudo o
 * que não dá para afirmar. É o primeiro dos quatro guardas da via de escrita
 * (projeção -> decisão -> pendência -> teto/gate).
 *
 * Nenhuma recusa aqui é "erro": é a resposta correta para dado que não permite
 * afirmação. Chute em registro acadêmico legal é pior que lacuna, porque lacuna
 * alguém vê.
 */

export type MotivoRecusaNota =
  /** A nota veio sem valor — etapa aberta, professor ainda não lançou. */
  | 'SEM_VALOR'
  /** `studentId` do Toddle sem de-para `STUDENT` ativo. */
  | 'ALUNO_NAO_MAPEADO'
  /** `gradingPeriodId` sem de-para `GRADING_PERIOD` ativo. */
  | 'ETAPA_NAO_MAPEADA'
  /** Nenhum `courseId`/`subjectId` da nota tem de-para `COURSE` ativo. */
  | 'TURMA_NAO_MAPEADA'
  /**
   * Mais de um IDTURMADISC candidato e a matrícula não desempatou. Escrever nos
   * dois duplicaria a nota do aluno; escolher um seria chute.
   */
  | 'TURMA_AMBIGUA'
  /**
   * O valor não é numérico — veio de escala alfabética. O RM guarda `NOTAFALTA`
   * decimal e a tabela de conceito dele está vazia: não existe régua oficial de
   * letra para número, e a conversão é decisão da escola.
   */
  | 'VALOR_NAO_NUMERICO'
  /** Fora da escala medida do RM (0 a 7 nesta escola). */
  | 'NOTA_FORA_DA_FAIXA'
  /**
   * O de-para de etapa é por ORDINAL (T1 -> etapa 1) e as janelas divergem. Nesta
   * data, esse ordinal aponta para a etapa errada. Ver D2 em docs/DECISOES.md.
   */
  | 'JANELA_INCOMPATIVEL'
  /** A etapa não existe no RM para essa turma-disciplina, ou não aceita digitação. */
  | 'ETAPA_NAO_GRAVAVEL'
  /** `SETAPAS.DISPONIVELALUNOS='N'` — a etapa não foi liberada ao aluno. */
  | 'ETAPA_NAO_LIBERADA';

/** A linha como o RM a receberia. */
export interface LinhaNota {
  codColigada: string;
  ra: string;
  idTurmaDisc: string;
  /** '1' | '2' | '3'. */
  codEtapa: string;
  /** Sempre `'N'`. Ver o cabeçalho de notaXml.ts. */
  tipoEtapa: typeof TIPOETAPA_NOTA;
  /** Já formatada para o `NOTAFALTA` (ponto decimal). */
  nota: string;
}

export interface ProjetadoNota {
  linha: LinhaNota;
  /** Chave natural do RM — a mesma da proveniência e da fila de pendências. */
  chaveRm: string;
  /** Identificador do lado do Toddle, para achar o registro de volta. */
  origemId: string;
  origem: ToddleNota;
}

export interface RecusadoNota {
  motivo: MotivoRecusaNota;
  /** Frase pronta para o relatório. */
  detalhe: string;
  origemId: string;
  origem: ToddleNota;
}

export type ResultadoProjecaoNota = ProjetadoNota | RecusadoNota;

const ehProjetado = (r: ResultadoProjecaoNota): r is ProjetadoNota => 'linha' in r;

/**
 * Chave natural da nota no RM, na ORDEM em que o XSD declara a `xs:unique
 * Constraint1`: CODCOLIGADA, CODETAPA, TIPOETAPA, IDTURMADISC, RA.
 *
 * A ordem não é estética: esta string é comparada com a que a leitura do RM
 * produz, e duas convenções diferentes de ordem fariam toda linha parecer nova —
 * o que transformaria `NADA_A_FAZER` em reescrita perpétua.
 */
export const chaveNaturalNota = (l: {
  codColigada: string;
  codEtapa: string;
  idTurmaDisc: string;
  ra: string;
}): string => `${l.codColigada}|${l.codEtapa}|${TIPOETAPA_NOTA}|${l.idTurmaDisc}|${l.ra}`;

/** Uma etapa de NOTA do RM, como `SETAPAS` a declara. */
export interface EtapaNotaRm {
  idTurmaDisc: string;
  codEtapa: string;
  dtInicio: string;
  dtFim: string;
  /** `PERMITEDIGITACAO='S'`. Sem isso a etapa é calculada, não digitável. */
  permiteDigitacao: boolean;
  /** `DISPONIVELALUNOS='S'`. Medido: 'N' em 100% das notas de hoje. */
  disponivelAlunos: boolean;
  aulasDadas: string | null;
}

/** A vigência de um grading period do Toddle. */
export interface JanelaToddle {
  inicio: string;
  fim: string;
}

/**
 * O de-para de etapa é por ORDINAL, e as janelas do Toddle não correspondem às
 * do RM. Este teste é o que impede a D2 de virar lançamento errado.
 *
 * ─── A REGRA ────────────────────────────────────────────────────────────────
 *
 * O ordinal só é confiável onde as duas janelas se SOBREPÕEM:
 *
 *   sem sobreposição            -> o ordinal está definitivamente errado
 *   sobreposição, data fora     -> nesta data o ordinal aponta para outra etapa
 *   sobreposição, data dentro   -> seguro
 *
 * Medido em 06/08/2026, e é o que produz as três faixas problemáticas
 * documentadas na D2:
 *
 *   18/05 -> 22/06   hoje está em T1, mas a etapa 1 do RM fechou em 15/05
 *   09/09 -> 22/09   hoje está em T2, mas a etapa 2 do RM fechou em 04/09
 *   21/11 -> 11/12   nenhum T cobre
 *
 * ─── POR QUE A DATA DE REFERÊNCIA É A DO RUN ────────────────────────────────
 *
 * A nota do Toddle carrega `gradingPeriodId`, não a data em que foi digitada — a
 * API não expõe isso. A data do run é o melhor proxy honesto: ela responde "o
 * ordinal está correto AGORA?". Uma nota digitada semanas antes pode escapar, e
 * é por isso que este teste é uma guarda e não uma prova. A correção de verdade
 * é arrumar as datas dos grading periods no portal (pendência do admin do
 * Toddle), e enquanto isso não acontece a recusa por janela é o que existe.
 */
export function janelaCompativel(
  dataRef: string,
  etapa: { dtInicio: string; dtFim: string },
  janela: JanelaToddle | undefined,
): { ok: boolean; porque: string } {
  if (!janela) {
    return {
      ok: false,
      porque:
        'o grading period do Toddle não tem vigência conhecida — sem as duas janelas ' +
        'não há como afirmar que o ordinal aponta para a etapa certa',
    };
  }

  const inicioSobreposicao = janela.inicio > etapa.dtInicio ? janela.inicio : etapa.dtInicio;
  const fimSobreposicao = janela.fim < etapa.dtFim ? janela.fim : etapa.dtFim;

  if (inicioSobreposicao > fimSobreposicao) {
    return {
      ok: false,
      porque:
        `as janelas não se cruzam: Toddle ${janela.inicio}→${janela.fim} contra ` +
        `RM ${etapa.dtInicio}→${etapa.dtFim}. O de-para por ordinal está errado aqui`,
    };
  }

  if (dataRef < inicioSobreposicao || dataRef > fimSobreposicao) {
    return {
      ok: false,
      porque:
        `em ${dataRef} o ordinal aponta para a etapa errada: a sobreposição entre ` +
        `Toddle ${janela.inicio}→${janela.fim} e RM ${etapa.dtInicio}→${etapa.dtFim} é ` +
        `${inicioSobreposicao}→${fimSobreposicao}`,
    };
  }

  return { ok: true, porque: `sobreposição ${inicioSobreposicao}→${fimSobreposicao}` };
}

export interface ContextoProjecaoNota {
  codColigada: string;
  /** `studentId` do Toddle -> RA. */
  alunoParaRa: Map<string, string>;
  /** `courseId`/`subjectId` do Toddle -> IDTURMADISC. */
  cursoParaTurmaDisc: Map<string, string>;
  /** `gradingPeriodId` -> CODETAPA ('1'|'2'|'3'). */
  periodoParaEtapa: Map<string, string>;
  /** Vigência de cada grading period do Toddle. */
  janelaDoPeriodo: Map<string, JanelaToddle>;
  /** Etapas de nota do RM, por `${idTurmaDisc}|${codEtapa}`. */
  etapasRm: Map<string, EtapaNotaRm>;
  /**
   * RA -> IDTURMADISC em que o aluno está matriculado. Desempata o fan-out de
   * `courseIds`. Quando ausente, ambiguidade vira recusa em vez de chute.
   */
  turmaDiscDoAluno?: Map<string, Set<string>>;
  /** Data de referência do teste de janela, "YYYY-MM-DD". */
  dataReferencia: string;
  /** Escala medida do RM nesta escola. */
  faixaNota: { min: number; max: number };
  /**
   * Exigir `DISPONIVELALUNOS='S'`? Medido: 'N' em 100% das 7.268 notas, e
   * ninguém sabe se a flag é gerenciada ou morta (pendência da escola em
   * docs/DECISOES.md). Default `true`: publicar nota não liberada mostraria à
   * família resultado provisório, e é irreversível do ponto de vista da
   * confiança.
   */
  exigirEtapaLiberada: boolean;
}

/** Projeta UMA nota. */
export function projetaNota(
  nota: ToddleNota,
  ctx: ContextoProjecaoNota,
): ResultadoProjecaoNota {
  const recusa = (motivo: MotivoRecusaNota, detalhe: string): RecusadoNota => ({
    motivo,
    detalhe,
    origemId: nota.origemId,
    origem: nota,
  });

  if (nota.valorCru === null) {
    return recusa('SEM_VALOR', 'a nota veio vazia do Toddle (etapa aberta)');
  }
  if (nota.valorNumerico === undefined) {
    return recusa(
      'VALOR_NAO_NUMERICO',
      `valor "${nota.valorCru}" (critério ${nota.criterio ?? '?'}) não é numérico. ` +
        'O RM guarda NOTAFALTA decimal e não há régua oficial de letra para número',
    );
  }
  if (nota.valorNumerico < ctx.faixaNota.min || nota.valorNumerico > ctx.faixaNota.max) {
    return recusa(
      'NOTA_FORA_DA_FAIXA',
      `nota ${nota.valorNumerico} fora da escala do RM (${ctx.faixaNota.min} a ${ctx.faixaNota.max})`,
    );
  }

  const ra = ctx.alunoParaRa.get(nota.studentId);
  if (!ra) {
    return recusa('ALUNO_NAO_MAPEADO', `studentId ${nota.studentId} sem de-para STUDENT ativo`);
  }

  const codEtapa = ctx.periodoParaEtapa.get(nota.gradingPeriodId);
  if (!codEtapa) {
    return recusa(
      'ETAPA_NAO_MAPEADA',
      `gradingPeriodId ${nota.gradingPeriodId} sem de-para GRADING_PERIOD ativo`,
    );
  }

  // ─── de-para de turma, com o fan-out de courseIds resolvido pela matrícula ──
  const candidatos = new Set<string>();
  for (const courseId of nota.courseIds) {
    const td = ctx.cursoParaTurmaDisc.get(courseId);
    if (td) candidatos.add(td);
  }
  // Subject-based grading (outras escolas do white label) e o próprio
  // teacherCourseId entram como candidatos quando o de-para os conhece.
  for (const alternativo of [nota.subjectId, nota.teacherCourseId]) {
    if (!alternativo) continue;
    const td = ctx.cursoParaTurmaDisc.get(alternativo);
    if (td) candidatos.add(td);
  }

  if (candidatos.size === 0) {
    return recusa(
      'TURMA_NAO_MAPEADA',
      `nenhum de-para COURSE ativo para courseIds=[${nota.courseIds.join(',')}] ` +
        `teacherCourseId=${nota.teacherCourseId ?? '-'} subjectId=${nota.subjectId ?? '-'}`,
    );
  }

  let idTurmaDisc: string;
  if (candidatos.size === 1) {
    idTurmaDisc = [...candidatos][0];
  } else {
    // Mais de uma turma-disciplina possível. O aluno está em UMA delas.
    const matriculado = ctx.turmaDiscDoAluno?.get(ra);
    const cruzamento = [...candidatos].filter((td) => matriculado?.has(td));
    if (cruzamento.length !== 1) {
      return recusa(
        'TURMA_AMBIGUA',
        `${candidatos.size} turmas-disciplina candidatas ([${[...candidatos].join(',')}]) e a ` +
          `matrícula do RA ${ra} ${matriculado ? `casou com ${cruzamento.length}` : 'não foi carregada'}. ` +
          'Escrever em todas duplicaria a nota',
      );
    }
    idTurmaDisc = cruzamento[0];
  }

  // ─── a etapa existe no RM e aceita digitação? ─────────────────────────────
  const etapa = ctx.etapasRm.get(`${idTurmaDisc}|${codEtapa}`);
  if (!etapa) {
    return recusa(
      'ETAPA_NAO_GRAVAVEL',
      `IDTURMADISC ${idTurmaDisc} não tem etapa ${codEtapa} de nota no RM`,
    );
  }
  if (!etapa.permiteDigitacao) {
    return recusa(
      'ETAPA_NAO_GRAVAVEL',
      `etapa ${codEtapa} da turma-disciplina ${idTurmaDisc} não permite digitação ` +
        '(PERMITEDIGITACAO≠S — provavelmente etapa calculada)',
    );
  }
  if (ctx.exigirEtapaLiberada && !etapa.disponivelAlunos) {
    return recusa(
      'ETAPA_NAO_LIBERADA',
      `etapa ${codEtapa} com DISPONIVELALUNOS='N' — escrever publicaria nota provisória`,
    );
  }

  // ─── a guarda da D2 ──────────────────────────────────────────────────────
  const janela = janelaCompativel(
    ctx.dataReferencia,
    etapa,
    ctx.janelaDoPeriodo.get(nota.gradingPeriodId),
  );
  if (!janela.ok) {
    return recusa('JANELA_INCOMPATIVEL', janela.porque);
  }

  const linha: LinhaNota = {
    codColigada: ctx.codColigada,
    ra,
    idTurmaDisc,
    codEtapa,
    tipoEtapa: TIPOETAPA_NOTA,
    nota: notaParaRm(nota.valorNumerico),
  };

  return { linha, chaveRm: chaveNaturalNota(linha), origemId: nota.origemId, origem: nota };
}

export interface ResumoProjecaoNota {
  projetados: ProjetadoNota[];
  recusados: RecusadoNota[];
  porMotivo: Record<string, number>;
  /**
   * Chaves naturais em que DUAS notas diferentes do Toddle caem no mesmo destino
   * do RM. Não é dedup — é colisão, e vai para revisão em vez de ser resolvida
   * escolhendo uma.
   */
  colisoes: string[];
}

/** Projeta o lote e resume. */
export function projetaLoteNotas(
  notas: ToddleNota[],
  ctx: ContextoProjecaoNota,
): ResumoProjecaoNota {
  const projetados: ProjetadoNota[] = [];
  const recusados: RecusadoNota[] = [];
  const porMotivo: Record<string, number> = {};

  for (const nota of notas) {
    const r = projetaNota(nota, ctx);
    if (ehProjetado(r)) projetados.push(r);
    else {
      recusados.push(r);
      porMotivo[r.motivo] = (porMotivo[r.motivo] ?? 0) + 1;
    }
  }

  const porChave = new Map<string, Set<string>>();
  for (const p of projetados) {
    const atual = porChave.get(p.chaveRm);
    if (atual) atual.add(p.linha.nota);
    else porChave.set(p.chaveRm, new Set([p.linha.nota]));
  }
  const colisoes = [...porChave.entries()].filter(([, v]) => v.size > 1).map(([k]) => k);

  logger.info(
    { lidas: notas.length, projetadas: projetados.length, recusadas: recusados.length, porMotivo, colisoes: colisoes.length },
    'Projeção de notas concluída',
  );

  return { projetados, recusados, porMotivo, colisoes };
}
