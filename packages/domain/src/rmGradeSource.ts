import { env, isRmSoapConfigured, logger } from '@rm-toddle/config';
import { wsConsultaSqlClient, type ConsultaRow } from '@rm-toddle/integrations';

/**
 * Fonte de NOTAS do RM, via Sentença `TODDLE.NOTAS`.
 *
 * Alimenta `POST /public/v2/term-grades`. Ver
 * docs/rm-sentencas/TODDLE.NOTAS.ESPEC.md.
 *
 * ─── O QUE FOI MEDIDO, E QUE MOLDA ESTE MÓDULO ──────────────────────────────
 *
 * 1. A nota é NUMÉRICA, de 0 a 7 (250 valores distintos, 4 decimais). As duas
 *    escalas do Toddle são ALFABÉTICAS (EXEM/EXC/… e A–E), e a tabela de conceito
 *    do RM está VAZIA — `COD_CONCEITO` em 0 de 3.876. Não existe régua oficial de
 *    número para letra, então a nota vai como *overall score*: só `postedGrade`,
 *    sem `gradeScaleId` e sem `criteriaType`, que é o que a API permite.
 *
 * 2. `ETAPA_LIBERADA = 'N'` em 100% das linhas. Sob a regra segura, nada é
 *    publicável — publicar nota não liberada mostra à família resultado
 *    provisório. Este módulo NÃO filtra por isso: ele MARCA cada nota e deixa a
 *    decisão para quem consome, porque ainda não se sabe se a flag é gerenciada
 *    ou se nunca é tocada nesta escola.
 *
 * 3. A chave `(RA, IDTURMADISC, CODETAPA)` é única — 3.876 para 3.876.
 *
 * 4. O de-para de etapa é por ORDINAL (etapa 1 → T1), não por data: as janelas
 *    do Toddle e do RM divergem. Ver migração 008.
 */

/** Uma nota de etapa, já recortada e tipada. */
export interface RmNota {
  codColigada: string;
  ra: string;
  idTurmaDisc: string;
  /** '1' | '2' | '3' — vira gradingPeriodId pelo de-para GRADING_PERIOD. */
  codEtapa: string;
  etapa: string;
  /** A nota como o RM guarda: string numérica de 0 a 7. Nunca convertida aqui. */
  nota: string;
  /** `nota` como número, para validação. NaN vira `undefined`. */
  notaNumerica?: number;
  codDisc?: string;
  disciplina?: string;
  codTurma?: string;
  codFilial: string;
  /** A etapa foi liberada ao aluno? Medido: 'N' em 100%. */
  etapaLiberada: boolean;
  /** Matrícula ativa na turma. 24 de 3.876 vinham 'N'. */
  alunoAtivo: boolean;
  statusDescricao?: string;
  criadoPelaIntegracao: boolean;
  alteradoEm?: string;
  criadoEm?: string;
}

export interface ResumoNotas {
  linhas: number;
  notas: RmNota[];
  foraDoEscopo: number;
  /** Linha de nota vazia — etapa aberta e ainda não lançada. */
  semNota: number;
  /** Domínios observados, para detectar mudança no RM sem aviso. */
  dominioEtapa: Record<string, number>;
  /** Quantas estão em etapa liberada. Hoje: 0. */
  emEtapaLiberada: number;
  /** Quantas são de aluno com matrícula inativa naquela turma. */
  deAlunoInativo: number;
  /** Maior ALTERADO_EM — marca d'água do sync incremental. */
  marcaDagua?: string;
  /** Faixa observada da nota, para detectar mudança de escala. */
  faixaNota?: { min: number; max: number };
}

const ehSim = (v: string | undefined): boolean =>
  ['S', 'SIM', '1', 'TRUE'].includes((v ?? '').trim().toUpperCase());

/**
 * Lê as notas do RM, recortadas por campus e pelo escopo de turma e aluno.
 *
 * @param idsTurmaDisc IDTURMADISC com mapeamento COURSE ativo.
 * @param ras RAs com mapeamento STUDENT ativo.
 *
 * Ambos são interseção POSITIVA: lista vazia é erro, nunca "tudo".
 */
export async function fetchNotasFromRm(
  idsTurmaDisc: string[],
  ras: string[],
): Promise<ResumoNotas> {
  if (!isRmSoapConfigured) {
    throw new Error('wsConsultaSQL não configurado (RM_WS_BASEURL/RM_WS_USER/RM_WS_PASS).');
  }
  if (!env.RM_SENTENCA_NOTAS) {
    throw new Error(
      'RM_SENTENCA_NOTAS não definido — informe o código da Sentença de notas (ex.: TODDLE.NOTAS).',
    );
  }
  if (!env.RM_CODPERLET) {
    throw new Error('RM_CODPERLET não definido — a Sentença de notas exige o período letivo.');
  }
  if (idsTurmaDisc.length === 0 || ras.length === 0) {
    throw new Error(
      'fetchNotasFromRm recebeu escopo vazio (turma ou aluno). Isto é recusa, não "ler tudo".',
    );
  }

  const rows = await wsConsultaSqlClient.realizarConsulta(env.RM_SENTENCA_NOTAS, {
    CODCOLIGADA: env.RM_CODCOLIGADA,
    CODPERLET: env.RM_CODPERLET,
  });

  const turmas = new Set(idsTurmaDisc);
  const alunos = new Set(ras);
  const todosCampi = env.RM_CODFILIAL.trim().toUpperCase() === 'ALL';
  const campiPermitidos = todosCampi
    ? []
    : env.RM_CODFILIAL.split(',').map((s) => s.trim()).filter(Boolean);

  const notas: RmNota[] = [];
  const dominioEtapa: Record<string, number> = {};
  let foraDoEscopo = 0;
  let semNota = 0;
  let emEtapaLiberada = 0;
  let deAlunoInativo = 0;
  let marcaDagua: string | undefined;
  let min = Infinity;
  let max = -Infinity;

  for (const row of rows) {
    const ra = pick(row, 'RA');
    const idTurmaDisc = pick(row, 'ID_TURMADISC', 'IDTURMADISC');
    const codFilial = pick(row, 'CODFILIAL') ?? '';

    // Recorte em três: campus, turma e aluno. Todos precisam bater.
    if (
      !ra ||
      !idTurmaDisc ||
      (!todosCampi && !campiPermitidos.includes(codFilial)) ||
      !turmas.has(idTurmaDisc) ||
      !alunos.has(ra)
    ) {
      foraDoEscopo += 1;
      continue;
    }

    // A Sentença já filtra TIPOETAPA='N', mas confiar sem conferir é como o
    // SELECT TOP 30 da Sentença de alunos: passa despercebido por dias.
    const tipo = pick(row, 'TIPOETAPA', 'TIPO_ETAPA');
    if (tipo && tipo.toUpperCase() !== 'N') {
      foraDoEscopo += 1;
      continue;
    }

    const codEtapa = pick(row, 'CODETAPA', 'COD_ETAPA') ?? '';
    dominioEtapa[codEtapa || '(vazio)'] = (dominioEtapa[codEtapa || '(vazio)'] ?? 0) + 1;

    const nota = pick(row, 'NOTA');
    if (!nota) semNota += 1;

    const numerica = nota ? Number(nota.replace(',', '.')) : NaN;
    if (Number.isFinite(numerica)) {
      if (numerica < min) min = numerica;
      if (numerica > max) max = numerica;
    }

    const liberada = ehSim(pick(row, 'ETAPA_LIBERADA'));
    if (liberada) emEtapaLiberada += 1;
    const ativo = ehSim(pick(row, 'STATUS_ATIVO'));
    if (!ativo) deAlunoInativo += 1;

    const alteradoEm = pick(row, 'ALTERADO_EM');
    if (alteradoEm && (marcaDagua === undefined || alteradoEm > marcaDagua)) marcaDagua = alteradoEm;

    const autor = (pick(row, 'CRIADO_POR') ?? '').trim().toLowerCase();
    const usuarioIntegracao = (env.RM_WS_USER ?? '').trim().toLowerCase();

    notas.push({
      codColigada: pick(row, 'CODCOLIGADA') ?? String(env.RM_CODCOLIGADA),
      ra,
      idTurmaDisc,
      codEtapa,
      etapa: pick(row, 'ETAPA') ?? '',
      nota: nota ?? '',
      notaNumerica: Number.isFinite(numerica) ? numerica : undefined,
      codDisc: pick(row, 'CODDISC'),
      disciplina: pick(row, 'DISCIPLINA'),
      codTurma: pick(row, 'COD_TURMA', 'CODTURMA'),
      codFilial,
      etapaLiberada: liberada,
      alunoAtivo: ativo,
      statusDescricao: pick(row, 'STATUS_DESCRICAO'),
      // Não guardamos o autor: CRIADO_POR traz CPF na frequência, e aqui o padrão
      // é o mesmo. Só interessa se fomos nós.
      criadoPelaIntegracao: usuarioIntegracao !== '' && autor === usuarioIntegracao,
      alteradoEm,
      criadoEm: pick(row, 'CRIADO_EM'),
    });
  }

  logger.info(
    {
      linhas: rows.length,
      notas: notas.length,
      foraDoEscopo,
      semNota,
      dominioEtapa,
      emEtapaLiberada,
      deAlunoInativo,
      marcaDagua,
      faixaNota: Number.isFinite(min) ? `${min}–${max}` : undefined,
    },
    'Notas lidas do RM via wsConsultaSQL',
  );

  return {
    linhas: rows.length,
    notas,
    foraDoEscopo,
    semNota,
    dominioEtapa,
    emEtapaLiberada,
    deAlunoInativo,
    marcaDagua,
    faixaNota: Number.isFinite(min) ? { min, max } : undefined,
  };
}

/** Busca uma coluna por vários nomes possíveis (case-insensitive), trimada. */
function pick(row: ConsultaRow, ...names: string[]): string | undefined {
  for (const name of names) {
    const direct = row[name];
    if (direct != null && direct !== '') return direct;
  }
  const lowered = new Map(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
  for (const name of names) {
    const v = lowered.get(name.toLowerCase());
    if (v != null && v !== '') return v;
  }
  return undefined;
}
