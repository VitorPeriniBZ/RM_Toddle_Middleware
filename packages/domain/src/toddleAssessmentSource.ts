import { logger } from '@rm-toddle/config';
import type { ToddleAssignment, ToddleStudentAssignment } from '@rm-toddle/integrations';

/**
 * Achata assignments + resultados por aluno na forma que a projeção consome.
 *
 * É a ORIGEM da via de nota por AVALIAÇÃO — a que substituiu a via de nota de
 * etapa, depois de medir que o `EduNotaEtapaData` descarta o valor.
 *
 *   assignment do Toddle  ->  SProvas   (a avaliação)
 *   resultado do aluno    ->  SNotas    (a nota da avaliação)
 *
 * ─── CONTAR RESULTADO NÃO É CONTAR NOTA ─────────────────────────────────────
 *
 * `GET /student-assignments` devolve TODOS os alunos atribuídos, avaliados ou
 * não. Medido em 09/09/2026: 2.085 resultados para 441 notas — quem não foi
 * avaliado vem com `score: []`. Tratar `edges.length` como volume de nota
 * infla o número em quase 5x, e o teto de volume reclamaria da coisa errada.
 */

/** Um assignment, recortado. */
export interface ToddleAvaliacao {
  assignmentId: string;
  titulo: string;
  /** `assessment/pt`, `learning_engagement/le`… Ver ToddleAssignment. */
  tipo: string;
  /** Casa com o de-para COURSE. `null` = não projetável. */
  classId: string | null;
  teacherCourseId: string | null;
  arquivado: boolean;
}

/** A nota de UM aluno em UMA avaliação. */
export interface ToddleNotaAvaliacao {
  assignmentId: string;
  studentId: string;
  studentName?: string;
  /** `academicTermId` — é por ele que sai o CODETAPA. */
  gradingPeriodId: string;
  /** O valor cru, como veio. Decimais sobrevivem: "8.5", "6.25". */
  valorCru: string;
  valor: number;
  /** `maxScore` — casa com `SProvas.VALOR`. `null` quando a API não mandou. */
  maximo: number | null;
  avaliadoEm: string;
  /** `null` = a nota NÃO foi compartilhada com o aluno; só o professor vê. */
  compartilhadoEm: string | null;
  origemId: string;
}

export interface ResumoAvaliacoes {
  avaliacoes: ToddleAvaliacao[];
  notas: ToddleNotaAvaliacao[];
  /** Resultados lidos, incluindo os não avaliados. */
  resultadosLidos: number;
  /** Sem nota lançada (`score: []`) — o caso mais comum. */
  semNota: number;
  /** Avaliado, mas com rubrica em vez de número. */
  soRubrica: number;
  /** Tipos observados, para a escola decidir quais valem. */
  porTipo: Record<string, number>;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

export function achataAvaliacoes(
  assignments: ToddleAssignment[],
  resultados: ToddleStudentAssignment[],
): ResumoAvaliacoes {
  const avaliacoes: ToddleAvaliacao[] = assignments.map((a) => ({
    assignmentId: String(a.id),
    titulo: String(a.title ?? '(sem título)'),
    tipo: `${a.assessmentType ?? '?'}/${a.subAssessmentType ?? ''}`,
    classId: a.classId ? String(a.classId) : null,
    teacherCourseId: a.teacherCourseId ? String(a.teacherCourseId) : null,
    arquivado: String(a.state ?? '').toUpperCase() === 'ARCHIVED',
  }));

  const porTipo: Record<string, number> = {};
  for (const a of avaliacoes) porTipo[a.tipo] = (porTipo[a.tipo] ?? 0) + 1;

  const notas: ToddleNotaAvaliacao[] = [];
  let semNota = 0;
  let soRubrica = 0;

  for (const r of resultados) {
    const d = r.assessmentToolData ?? {};
    const s = (d.score ?? [])[0];
    const valor = num(s?.value);

    if (valor === null) {
      // Sem número. Distinguimos os dois casos porque significam coisas
      // diferentes para a escola: "ninguém avaliou ainda" contra "avaliou com
      // rubrica, e rubrica não tem número para o RM".
      if ((d.rubric ?? []).length > 0) soRubrica += 1;
      else semNota += 1;
      continue;
    }

    const gradingPeriodId = r.academicTermId ? String(r.academicTermId) : '';
    if (!gradingPeriodId) {
      logger.warn(
        { assignmentId: r.assignmentId, studentId: r.studentId },
        'Resultado do Toddle sem academicTermId — sem CODETAPA possível, descartado',
      );
      continue;
    }

    notas.push({
      assignmentId: String(r.assignmentId),
      studentId: String(r.studentId),
      studentName: r.studentName,
      gradingPeriodId,
      valorCru: String(s?.value),
      valor,
      maximo: num(s?.maxScore),
      avaliadoEm: String(r.evaluatedAt ?? ''),
      compartilhadoEm: r.evaluationSharedAt ? String(r.evaluationSharedAt) : null,
      origemId: `${r.assignmentId}:${r.studentId}`,
    });
  }

  logger.info(
    {
      avaliacoes: avaliacoes.length,
      resultadosLidos: resultados.length,
      notas: notas.length,
      semNota,
      soRubrica,
      porTipo,
    },
    'Avaliações do Toddle achatadas',
  );

  return {
    avaliacoes,
    notas,
    resultadosLidos: resultados.length,
    semNota,
    soRubrica,
    porTipo,
  };
}
