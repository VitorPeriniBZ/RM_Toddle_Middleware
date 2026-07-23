/**
 * Convenção de nomes: `{direcao}.{entidade}`.
 * Uma fila por entidade+direção isola falhas e permite escalar/pausar
 * cada sincronização de forma independente.
 */
export const QUEUE = {
  // Fluxo 1: TOTVS RM -> Toddle (cadastros)
  RM_TO_TODDLE_STUDENTS: 'rm-to-toddle.students',
  RM_TO_TODDLE_STAFF: 'rm-to-toddle.staff',
  RM_TO_TODDLE_PARENTS: 'rm-to-toddle.parents',
  // Toddle 2.0: turmas seguem o modelo TeacherCourse (ver README, Fluxo 2).
  RM_TO_TODDLE_COURSES: 'rm-to-toddle.courses',

  // Fluxo 2: Toddle -> TOTVS RM (acadêmico, via SQL)
  TODDLE_TO_RM_ENROLLMENTS: 'toddle-to-rm.enrollments',
  TODDLE_TO_RM_ATTENDANCE: 'toddle-to-rm.attendance',
  TODDLE_TO_RM_TERM_GRADES: 'toddle-to-rm.term-grades',
  TODDLE_TO_RM_TIMETABLE: 'toddle-to-rm.timetable',

  // Registros que esgotaram as retentativas (reprocessamento manual)
  DEAD_LETTER: 'dead-letter',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

/** Nomes de job dentro da fila de alunos (padrão extract -> fan-out de lotes). */
export const STUDENT_JOB = {
  EXTRACT: 'students.extract',
  UPSERT_BATCH: 'students.upsert-batch',
} as const;
