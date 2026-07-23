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
  name?: string;
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
