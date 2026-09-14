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

/**
 * Job de professor. NÃO tem fan-out em lotes, ao contrário do de aluno: são 35
 * professores e ~200 turma-disciplina, e a escrita real é de poucos registros
 * por noite. Fatiar traria só a complexidade, sem o ganho.
 */
export const STAFF_JOB = {
  SYNC: 'staff.sync',
} as const;

/**
 * Job da via de NOTA (Toddle -> RM). Sem fan-out: uma passada lê tudo e o
 * guarda de decisão resolve o que mudou, porque o `GET /term-grades` do Toddle
 * não tem filtro `modifiedSince`.
 */
export const TERM_GRADE_JOB = {
  SYNC: 'term-grades.sync',
} as const;

/**
 * Job de TURMA E DISCIPLINA (RM -> de-para). SOMENTE LEITURA.
 *
 * O nome diz `sync` por convenção das filas, mas ele não sincroniza nada: o
 * Toddle não tem DELETE de turma, só arquivar, então criar turma automaticamente
 * seria a única ação irreversível deste projeto. Ele DETECTA a deriva e para aí.
 */
export const COURSE_JOB = {
  SYNC: 'courses.sync',
} as const;

/**
 * Job de FREQUÊNCIA (Toddle -> RM). A segunda escrita agendada em registro
 * acadêmico, atrás dos mesmos quatro guardas que o CLI usa.
 */
export const ATTENDANCE_JOB = {
  SYNC: 'attendance.sync',
} as const;
