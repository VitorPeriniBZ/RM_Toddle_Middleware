/**
 * Tipos da Toddle Open API V2 (Toddle 1.0).
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
  archived?: boolean;
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
