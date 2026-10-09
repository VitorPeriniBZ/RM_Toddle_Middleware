/**
 * Tipos da Toddle Open API V2 (Toddle 2.0 — modelo TeacherCourse, usado pela EAV).
 * O endpoint de alunos é o mesmo núcleo estável entre Toddle 1.0 e 2.0; as
 * diferenças do 2.0 concentram-se em courses (TeacherCourses) e no Grade Scale.
 * Regra de ouro: TODO ID é String no JSON (ex.: "13892").
 */
export interface ToddleStudent {
  id: string;
  firstName?: string;
  lastName?: string;
  preferredName?: string;
  email?: string;
  gender?: 'M' | 'F' | 'X';
  /** YYYY-MM-DD */
  dob?: string;
  /** Código de negócio do sistema de origem (aqui: prefixo + RA do RM). */
  sourceId?: string;
  yearGroupId?: string;
  /**
   * Situação de arquivamento. O GET /students devolve `isArchived`; as respostas
   * de archive/unarchive usam `is_archived` (snake_case) — a index signature
   * abaixo cobre a variante. Use o helper isToddleStudentArchived().
   */
  isArchived?: boolean;
  [key: string]: unknown;
}

/** GET /public/v2/students → { response: { students, pageNumber, ... } } */
export interface ToddleStudentsListResponse {
  response?: {
    students?: ToddleStudent[];
    pageNumber?: number;
    responseSize?: number;
    totalStudents?: number;
  };
}

/** POST /public/v2/students e PUT /:id → { response: { student } } */
export interface ToddleStudentResponse {
  response?: {
    student?: ToddleStudent;
  };
}

export interface ToddleYearGroup {
  id: string;
  /** Coorte de formatura, ex.: "Batch of 2032" — NÃO é a série. */
  name?: string;
  /** Série(s) ligada(s) à coorte, ex.: [{ id, name: "Grade 6" }]. */
  grades?: Array<{ id: string; name?: string }>;
  organizationId?: string;
  organizationName?: string;
  [key: string]: unknown;
}

/** GET /public/v2/year-groups → { response: { yearGroups } } */
export interface ToddleYearGroupsResponse {
  response?: {
    yearGroups?: ToddleYearGroup[];
  };
}

/**
 * A API é inconsistente na grafia do flag de arquivamento (`isArchived` no
 * GET /students, `is_archived` nas respostas de archive/unarchive). Este helper
 * lê as duas formas com segurança.
 */
export function isToddleStudentArchived(student: ToddleStudent): boolean {
  return student.isArchived === true || student['is_archived'] === true;
}

/**
 * Um registro de chamada, como o GET /public/v2/attendance devolve.
 *
 * Os campos anuláveis não são detalhe: `courseId`/`periodId` nulos é o caso real
 * da chamada de homeroom (`masterAttendance`), e `startTime` pode vir como a
 * STRING "null". Tudo isso é motivo de RECUSA na projeção para o RM, nunca de
 * inferência — sem curso não existe IDTURMADISC, e sem horário não existe
 * IDHORARIOTURMA.
 */
export interface ToddleAttendance {
  id: string | number;
  studentId: string | number | null;
  courseId: string | number | null;
  periodId: string | number | null;
  /** "YYYY-MM-DD" */
  date: string;
  /** ISO 8601 com Z, ex.: "2024-09-16T01:29:58.365Z". */
  lastModifiedTimeStamp?: string;
  isDeleted?: boolean;
  notes?: string | null;
  /** "8:00:00" — sem zero à esquerda, e às vezes a string "null". */
  startTime?: string | null;
  endTime?: string | null;
  attendanceOption?: {
    id: string | number;
    label?: string;
    abbreviation?: string;
  } | null;
  [key: string]: unknown;
}

/** Paginação por cursor (edges/pageInfo), diferente do pageNumber de /students. */
export interface ToddlePageInfo {
  hasNextPage?: boolean;
  hasPreviousPage?: boolean;
  startCursor?: string | null;
  endCursor?: string | null;
}

export interface ToddleAttendanceListResponse {
  response?: {
    totalCount?: number;
    edges?: ToddleAttendance[];
    pageInfo?: ToddlePageInfo;
  };
}

/** Código de chamada configurado no Toddle (Present, Absent, Late, …). */
export interface ToddleAttendanceCode {
  id: string | number;
  label?: string;
  abbreviation?: string;
  /** 1.0 = presença plena, 0.0 = ausência; usado no cálculo do Toddle. */
  value?: number;
  isDefault?: boolean;
  curriculumId?: string;
  academicYearId?: string;
  [key: string]: unknown;
}

export interface ToddleAttendanceCodesResponse {
  response?: {
    totalCount?: number;
    edges?: ToddleAttendanceCode[];
    pageInfo?: ToddlePageInfo;
  };
}

/**
 * Grade de horário. É a única fonte de hora de aula na API: o `startTime` do
 * registro de frequência vem nulo (medido: 800 de 800).
 *
 * O `periodSet` liga períodos a horas. O mesmo `periodId` pode aparecer em bell
 * schedules diferentes com horas diferentes — quem resolve precisa detectar isso
 * e recusar, não escolher.
 */
export interface ToddleBellSchedule {
  id: string;
  label?: string;
  curriculumId?: string;
  academicYearId?: string;
  periodSet?: Array<{
    periodId: string;
    /** "08:00:00" */
    startTime?: string | null;
    endTime?: string | null;
  }>;
  [key: string]: unknown;
}

export interface ToddleBellScheduleResponse {
  response?: {
    totalCount?: number;
    bellSchedules?: ToddleBellSchedule[];
    pageInfo?: ToddlePageInfo;
  };
}

/**
 * Slot da grade: qual turma ocupa qual período em qual dia da semana.
 *
 * É o nível que o Toddle valida quando alguém lança frequência — sem slot, o
 * `POST /attendance` recusa com "Attendance Record is not valid". Corresponde
 * 1:1 a uma linha de `SHorarioTurma` do RM.
 *
 * O GET devolve EXPANDIDO POR DATA: um slot semanal aparece uma vez por
 * ocorrência na janela consultada, com `date` preenchida.
 */
export interface ToddleTimetableSlot {
  periodId?: string;
  courseId?: string;
  /** Dia da semana. Mesma convenção do DIASEMANA do RM (segunda = 2). */
  weekday?: number;
  rotationDayId?: string | null;
  staffIds?: string[];
  location?: string;
  subjectInfo?: string;
  startTime?: string;
  endTime?: string;
  curriculumProgramId?: string;
  /** Ocorrência concreta, "YYYY-MM-DD". */
  date?: string;
  routineId?: string;
  [key: string]: unknown;
}

export interface ToddleTimetableSlotsResponse {
  response?: {
    totalCount?: number;
    edges?: ToddleTimetableSlot[];
    pageInfo?: ToddlePageInfo;
  };
}

/**
 * Routine — qual grade de horário vale em qual dia, para quais séries.
 *
 * `bellSchedulesMapping` VAZIO é o que torna a grade inerte: com ele vazio,
 * `POST /timetable-slots` responde `{ isSuccess: true }` e nada é criado.
 * Medido em 04/08/2026 na routine "ENC" desta organização.
 */
export interface ToddleRoutine {
  id: string;
  label?: string;
  curriculumProgramId?: string;
  academicYearId?: string;
  /** 'OPERATIONAL_DAYS' | 'ROTATION_CYCLE' */
  routineMode?: string;
  dayPatternType?: string;
  countHolidayAsRotationDay?: boolean;
  validity?: { startDate?: string; endDate?: string };
  rotationDays?: Array<Record<string, unknown>>;
  dayPatterns?: Array<Record<string, unknown>>;
  grades?: Array<{ id: string; name?: string }>;
  /** Leitura: como o GET devolve o mapeamento dia → grade de horário. */
  bellSchedulesMapping?: Array<Record<string, unknown>>;
  routineUpdateEvents?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/**
 * Responsável (parent). O `GET /parents` devolve `email` e `children`, o que torna
 * a idempotência recuperável pela API — diferente de período, cujo de-para só vive
 * no nosso banco.
 *
 * O `email` é a identidade: duas pessoas com o mesmo endereço não podem coexistir.
 */
export interface ToddleParent {
  id: string | number;
  firstName?: string;
  lastName?: string;
  email?: string;
  phoneNumber?: string | null;
  sourceId?: string | null;
  children?: Array<{
    id: string;
    firstName?: string;
    lastName?: string;
    relationship?: string;
  }>;
  [key: string]: unknown;
}

/**
 * Grading period — o "trimestre" do boletim no Toddle.
 *
 * ATENÇÃO: as janelas NÃO correspondem às etapas do RM. O ano acadêmico do Toddle
 * é de hemisfério norte (nov→nov) e o ano letivo brasileiro é fev→dez, então o T1
 * engloba o 1º trimestre do RM inteiro e parte do 2º. O de-para é por ORDINAL —
 * ver a migração 008.
 */
export interface ToddleGradingPeriod {
  id: string | number;
  name?: string;
  label?: string;
  /** 'REPORTING' nos que servem para boletim. */
  type?: string;
  startDate?: string;
  endDate?: string;
  academicYearId?: string;
  curriculumProgramId?: string;
  isCurrentAcademicYear?: boolean;
  [key: string]: unknown;
}

/**
 * Uma nota de etapa como o `GET /public/v2/term-grades` devolve.
 *
 * A resposta é ANINHADA: `edges[]` é uma lista de ALUNOS, e cada aluno traz
 * `ratings[]` com uma entrada por (teacher course × grading period × critério).
 * Aluno sem nota lançada vem com `ratings: []` — medido em 09/09/2026: 257 de
 * 257 alunos do currículo UBD vinham vazios, porque ninguém lançou nota no
 * Toddle ainda.
 *
 * ─── ONDE ESTÁ O VALOR, E POR QUE SÃO DOIS LUGARES ──────────────────────────
 *
 * `academicCriteriaSetType` discrimina:
 *
 *   `FINAL_SCORE`  → o valor está em `score`, string numérica ("33")
 *   `GRADE_SCALE`  → o valor está em `criteriaValueLabel`/`criteriaValueId`,
 *                    e é a ABREVIAÇÃO da escala ("A", "EXEM")
 *
 * Isso importa porque o RM guarda `NOTAFALTA` numérico. Medido em 09/09/2026,
 * as duas escalas desta organização são `valueType: "ALPHA"` (EXEM/EXC/EXH/EVL/
 * EMER/NA e A–E) — não existe escala numérica cadastrada no Toddle, e a tabela
 * de conceito do RM está vazia. Nota que chegar por `GRADE_SCALE` não tem régua
 * oficial para virar número, e a projeção RECUSA em vez de inventar conversão.
 *
 * ─── O READ E O WRITE NÃO USAM O MESMO FORMATO ──────────────────────────────
 *
 * Medido criando uma nota de verdade no sandbox em 09/09/2026:
 *
 *   POST postedGrade "6"    -> aceito, resposta `value: "6"`
 *   POST postedGrade "6.5"  -> HTTP 400: "For FINAL_SCORE, postedGrade must be
 *                              an integer value."
 *   GET  devolve            -> `score: "6.0"`
 *
 * Duas consequências. A primeira é de parsing: o read acrescenta `.0`, então
 * comparar STRING com o valor do RM ("6.0000") veria diferença onde não há e
 * reescreveria a mesma nota para sempre — a comparação é numérica.
 *
 * A segunda é de escopo, e é maior: **`FINAL_SCORE` só aceita inteiro.** O RM
 * guarda a nota com 4 decimais e usa: a primeira aluna real que este projeto
 * consultou tem `6,5000` lançado à mão no RM, e não existe forma de o professor
 * expressar 6,5 como nota geral no Toddle. Quem decide o que fazer com as casas
 * decimais é a escola — está na tabela de pendências de docs/DECISOES.md.
 *
 * ─── CAMPOS QUE A DOC DO TODDLE NÃO LISTA ───────────────────────────────────
 *
 * A resposta real trouxe `isOverridden`, `categoryId` e `categoryName`. O
 * `isOverridden: true` apareceu na nota postada por API — o que sugere que ele
 * distingue nota digitada/sobreposta de nota calculada pelo gradebook. NÃO foi
 * medido com nota calculada, então é hipótese, não afirmação.
 *
 * ─── `courseIds` É UM ARRAY ─────────────────────────────────────────────────
 *
 * Um teacher course pode ter várias turmas (`courseIds: [{id, name}, …]`), e o
 * de-para `COURSE` mapeia IDTURMADISC → courseId. Uma nota, portanto, pode
 * apontar para mais de um IDTURMADISC — o aluno está em UMA delas, e quem
 * desempata é a matrícula. Escrever nas duas duplicaria a nota.
 */
export interface ToddleTermGradeRating {
  subjectId?: string | null;
  subjectName?: string | null;
  teacherCourseId?: string | null;
  teacherCourseTitle?: string | null;
  courseIds?: Array<{ id?: string | number; name?: string }> | null;
  gradingPeriodId?: string | null;
  /**
   * Valor quando o critério é `FINAL_SCORE`. String, não número — e o read
   * devolve com `.0` ("6.0") mesmo tendo aceitado "6" na escrita.
   */
  score?: string | number | null;
  academicCriteriaSetLabel?: string | null;
  academicCriteriaSetId?: string | null;
  /** `FINAL_SCORE` | `FINAL_GRADE` | `GRADE_SCALE` | `LOCAL_GRADE` | `IB_DEFINED`. */
  academicCriteriaSetType?: string | null;
  criteriaLabel?: string | null;
  gradeLevelId?: string | null;
  criteriaValueId?: string | null;
  /** Valor quando o critério é de escala: a abreviação ("A", "EXEM"). */
  criteriaValueLabel?: string | null;
  [key: string]: unknown;
}

/** Um aluno na resposta do `GET /term-grades`, com as notas dele. */
export interface ToddleTermGradeStudent {
  id: string | number;
  name?: string;
  yearGroup?: string;
  ratings?: ToddleTermGradeRating[];
  [key: string]: unknown;
}

export interface ToddleTermGradesResponse {
  response?: {
    totalCount?: number;
    edges?: ToddleTermGradeStudent[];
    pageInfo?: { hasNextPage?: boolean; endCursor?: string };
  };
}

/**
 * Uma escala de notas do `GET /public/v2/grade-scale`.
 *
 * `valueType` é o campo decisivo: `ALPHA` significa que a nota trafega como
 * letra/abreviação, e não há conversão automática para o numérico do RM.
 */
export interface ToddleGradeScale {
  gradeScaleId: string;
  gradeScaleLabel?: string;
  scaleType?: string;
  /** `ALPHA` ou numérico. Medido na EAV: as duas escalas são `ALPHA`. */
  valueType?: string;
  criteriaType?: string;
  values?: Array<{ gradeValueId?: string; abbreviation?: string; label?: string }>;
  [key: string]: unknown;
}

export interface ToddleGradeScalesResponse {
  response?: { gradeScales?: ToddleGradeScale[] };
}

/**
 * Sinaliza nota sobreposta manualmente, em vez de calculada pelo gradebook.
 * Observado como `true` na nota criada por API; não medido com nota calculada.
 */

/**
 * Um assignment do Toddle — a "avaliação" que o professor cria. Corresponde a
 * `SProvas` no RM.
 *
 * `assessmentType`/`subAssessmentType` classificam o que o professor escolheu na
 * interface. Medido em 09/09/2026: escolher "Avaliação" produz `assessment/pt`;
 * os 223 do sandbox se dividem em `learning_engagement/le` (111),
 * `assessment/fmt` (38), `learning_engagement/` (30), `assessment/pt` (16),
 * `ai_tutor/ai_tutor` (12), `worksheet/worksheet` (6), `assessment/pri` (6) e
 * `assessment/` (4). QUAIS desses viram nota no RM é decisão da escola.
 *
 * `classId` é o que casa com o de-para `COURSE` (IDTURMADISC). `teacherCourseId`
 * é o agrupador e pode cobrir VÁRIAS turmas — por isso o de-para usa o classId.
 */
export interface ToddleAssignment {
  id: string | number;
  title?: string;
  state?: string;
  assessmentType?: string | null;
  subAssessmentType?: string | null;
  teacherCourseId?: string | null;
  teacherCourseName?: string | null;
  classId?: string | null;
  className?: string | null;
  curriculumProgramId?: string | null;
  categoryId?: string | null;
  categoryName?: string | null;
  dueDate?: string | null;
  publishedAt?: string | null;
  createdAt?: string | null;
  createdBy?: string | null;
  [key: string]: unknown;
}

export interface ToddleAssignmentsResponse {
  response?: {
    totalCount?: number;
    edges?: ToddleAssignment[];
    pageInfo?: { hasNextPage?: boolean; endCursor?: string };
  };
}

/**
 * O resultado de UM aluno em UM assignment — corresponde a `SNotas` no RM.
 *
 * ─── ONDE ESTÁ A NOTA, E COMO SABER SE FOI AVALIADO ─────────────────────────
 *
 * `assessmentToolData.score[0]` traz `{ value, maxScore }`. Medido lançando nota
 * pela tela do professor em 09/09/2026:
 *
 *   avaliado      -> {"score":[{"id":"…","value":"8.5","maxScore":"10"}]}
 *   NÃO avaliado  -> {"score":[]}
 *
 * A distinção é o array vazio, e `evaluatedAt` confirma. **Decimais sobrevivem**
 * (`8.5`, `6.25` voltam exatos) — ao contrário do `FINAL_SCORE` do
 * `/term-grades`, que só aceita inteiro.
 *
 * `academicTermId` é o grading period, e é por ele que sai o `CODETAPA`.
 *
 * `evaluationSharedAt` diz se a nota já foi compartilhada com o aluno. Nulo
 * significa que só o professor a vê — o estado em que uma nota de teste deve
 * ficar.
 */
export interface ToddleStudentAssignment {
  assignmentId: string | number;
  assignmentTitle?: string;
  assignmentType?: string | null;
  studentId: string | number;
  studentName?: string;
  evaluatedAt?: string | null;
  evaluationSharedAt?: string | null;
  academicTermId?: string | null;
  academicTermName?: string | null;
  assessmentToolData?: {
    score?: Array<{ id?: string; value?: string | number; maxScore?: string | number }>;
    rubric?: Array<Record<string, unknown>>;
    remark?: Array<Record<string, unknown>>;
  } | null;
  [key: string]: unknown;
}

export interface ToddleStudentAssignmentsResponse {
  response?: {
    totalCount?: number;
    edges?: ToddleStudentAssignment[];
    pageInfo?: { hasNextPage?: boolean; endCursor?: string };
  };
}

/**
 * Uma nota publicada, como o `GET /progress-summary` devolve.
 *
 * snake_case, diferente do resto da API — é como a rota responde. Medido em
 * 09/10/2026 com `ratingType=AssignmentRatings`: `published_at` e `updated_at`
 * vêm SEM fuso (`"2026-09-09 19:59:07.753454"`), e o filtro `fromDate` aceita o
 * mesmo formato COM hora — não documentado, mas testado: `fromDate` às 19:59
 * devolveu exatamente as 3 notas posteriores de 5.
 */
export interface ToddleNotaPublicada {
  id: string;
  class_id?: string | null;
  class_sourced_id?: string | null;
  class_title?: string | null;
  student_id?: string | null;
  assignment_id?: string | null;
  term_id?: string | null;
  published_at?: string | null;
  updated_at?: string | null;
  value?: string | null;
  [key: string]: unknown;
}

export interface ToddleProgressSummaryResponse {
  response?: {
    totalCount?: number;
    edges?: ToddleNotaPublicada[];
    pageInfo?: ToddlePageInfo;
  };
}
