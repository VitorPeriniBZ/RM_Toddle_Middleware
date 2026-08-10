import { env, isRmSoapConfigured, logger, sanitizeEmail } from '@rm-toddle/config';
import { wsConsultaSqlClient, ConsultaRow } from '@rm-toddle/integrations';

/**
 * Fonte de PROFESSOR e de alocação turma-disciplina-docente, via a Sentença
 * `TODDLE.TURMADISC` (wsConsultaSQL).
 *
 * ─── POR QUE ESTA SENTENÇA, E NÃO O DATASERVER ──────────────────────────────
 *
 * `reconciliar:turmas` lê `EduTurmaDiscData`, que devolve a turma-disciplina com
 * 39 colunas — mas NÃO o professor alocado. Esta Sentença existe exatamente para
 * cobrir essa lacuna. Medido em 10/08/2026 (coligada 1, perlet 2026):
 *
 *   648 linhas no total · 286 no campus 2 · 202 turma-disciplina distintas
 *    35 professores distintos · 0 linhas sem CODPROF
 *
 * ─── A GRANULARIDADE É A ALOCAÇÃO, NÃO O PROFESSOR ──────────────────────────
 *
 * Uma linha = um professor numa turma-disciplina. Logo há repetição em ambos os
 * eixos: **70 das 202 turma-disciplina têm mais de um professor** (até três), e
 * um professor aparece em várias. Quem consome precisa agrupar — e é por isso
 * que esta função devolve as duas visões prontas, em vez do rowset cru.
 */

/** Um professor, deduplicado por CODPROF. */
export interface RmTeacher {
  /** `CODPROF` — chave de negócio, vira o `rm_code` do mapeamento STAFF. */
  codProf: string;
  nome: string;
  /** Institucional tem precedência; pessoal é fallback. `undefined` = bloqueia criação. */
  email?: string;
  /** IDs de turma-disciplina em que ele leciona (no escopo). */
  turmaDiscIds: string[];
}

/** Uma turma-disciplina com os professores alocados. */
export interface RmTurmaDisc {
  /** `ID_TURMADISC` — casa com o `rm_code` do mapeamento COURSE. */
  idTurmaDisc: string;
  codTurma: string;
  nomeTurma: string;
  codDisc: string;
  nomeDisciplina: string;
  segmento: string;
  serie: string;
  secao: string;
  ativa: boolean;
  /** CODPROF dos docentes alocados. Pode ter mais de um. */
  codProfs: string[];
}

export interface RmTeacherData {
  professores: Map<string, RmTeacher>;
  turmaDiscs: Map<string, RmTurmaDisc>;
  /** Linhas descartadas por campus fora de escopo (RM_CODFILIAL). */
  foraDoEscopo: number;
  /** Linhas sem CODPROF — turma-disciplina sem docente alocado no RM. */
  semProfessor: number;
}

export async function fetchTeachersFromRm(): Promise<RmTeacherData> {
  if (!isRmSoapConfigured) {
    throw new Error('wsConsultaSQL não configurado (RM_WS_BASEURL/RM_WS_USER/RM_WS_PASS).');
  }
  if (!env.RM_SENTENCA_TURMADISC) {
    throw new Error(
      'RM_SENTENCA_TURMADISC não definido — informe o código da Sentença de turma-disciplina-professor ' +
        '(ex.: TODDLE.TURMADISC). Ver docs/rm-sentencas/TODDLE.TURMADISC.ESPEC.md.',
    );
  }
  if (!env.RM_CODPERLET) {
    throw new Error('RM_CODPERLET não definido — a Sentença exige o período letivo (ex.: 2026).');
  }

  const rows = await wsConsultaSqlClient.realizarConsulta(env.RM_SENTENCA_TURMADISC, {
    CODCOLIGADA: env.RM_CODCOLIGADA,
    CODPERLET: env.RM_CODPERLET,
  });

  // Escopo por campus, idêntico ao da Sentença de alunos. A Sentença NÃO filtra
  // campus de propósito (ver ESPEC §2), então o filtro vive aqui — e é o que
  // mantém a D4 (Pre-K a Grade 5 fora) valendo: das 648 linhas, 286 são campus 2.
  const todosOsCampi = env.RM_CODFILIAL.trim().toUpperCase() === 'ALL';
  const permitidos = todosOsCampi
    ? []
    : env.RM_CODFILIAL.split(',').map((s) => s.trim()).filter(Boolean);
  if (!todosOsCampi && permitidos.length === 0) {
    throw new Error(`RM_CODFILIAL="${env.RM_CODFILIAL}" não produziu campus válido.`);
  }

  const professores = new Map<string, RmTeacher>();
  const turmaDiscs = new Map<string, RmTurmaDisc>();
  let foraDoEscopo = 0;
  let semProfessor = 0;

  for (const row of rows) {
    const idTurmaDisc = pick(row, 'ID_TURMADISC');
    if (!idTurmaDisc) continue; // linha sem chave não é acionável

    const campus = pick(row, 'CODFILIAL');
    if (!todosOsCampi && (!campus || !permitidos.includes(campus))) {
      foraDoEscopo += 1;
      continue;
    }

    if (!turmaDiscs.has(idTurmaDisc)) {
      turmaDiscs.set(idTurmaDisc, {
        idTurmaDisc,
        codTurma: pick(row, 'COD_TURMA') ?? '',
        nomeTurma: pick(row, 'NOME_TURMA') ?? '',
        codDisc: pick(row, 'CODDISC') ?? '',
        nomeDisciplina: pick(row, 'NOME_DISCIPLINA') ?? '',
        segmento: pick(row, 'SEGMENTO') ?? '',
        serie: pick(row, 'SERIE') ?? '',
        secao: pick(row, 'SECAO') ?? '',
        // 'S' = ativa. Qualquer outro valor conta como inativa, inclusive vazio:
        // na dúvida, NÃO tratar como ativa.
        ativa: (pick(row, 'TURMADISC_ATIVA') ?? '').toUpperCase() === 'S',
        codProfs: [],
      });
    }

    const codProf = pick(row, 'CODPROF');
    if (!codProf) {
      semProfessor += 1;
      continue;
    }

    const td = turmaDiscs.get(idTurmaDisc)!;
    if (!td.codProfs.includes(codProf)) td.codProfs.push(codProf);

    if (!professores.has(codProf)) {
      professores.set(codProf, {
        codProf,
        nome: pick(row, 'NOME_PROFESSOR') ?? '',
        // Institucional tem precedência. Sem nenhum dos dois, o professor NÃO
        // pode ser criado: o Toddle exige e-mail e o usa como IDENTIDADE —
        // e-mail errado gera conta inacessível, que só pode ser arquivada.
        email:
          sanitizeEmail(pick(row, 'EMAIL_PROFESSOR')) ??
          sanitizeEmail(pick(row, 'EMAIL_PROF_PESSOAL')),
        turmaDiscIds: [],
      });
    }
    const prof = professores.get(codProf)!;
    if (!prof.turmaDiscIds.includes(idTurmaDisc)) prof.turmaDiscIds.push(idTurmaDisc);
  }

  logger.info(
    {
      linhas: rows.length,
      turmaDiscs: turmaDiscs.size,
      professores: professores.size,
      semEmail: [...professores.values()].filter((p) => !p.email).length,
      foraDoEscopo,
      semProfessor,
      campi: permitidos.length > 0 ? permitidos.join(',') : 'todos',
    },
    'Turma-disciplina-professor lida via wsConsultaSQL',
  );

  return { professores, turmaDiscs, foraDoEscopo, semProfessor };
}

/** Busca coluna por vários nomes (case-insensitive), trimada. */
function pick(row: ConsultaRow, ...names: string[]): string | undefined {
  for (const name of names) {
    const v = row[name];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  const lowered = new Map(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
  for (const name of names) {
    const v = lowered.get(name.toLowerCase());
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return undefined;
}
