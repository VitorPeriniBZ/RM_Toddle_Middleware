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
