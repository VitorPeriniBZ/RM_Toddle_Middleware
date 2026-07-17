/**
 * Tipos da API TOTVS RM Educacional (padrão TOTVS TALK).
 * Wrapper de paginação: { hasNext, items } — consumir com page + pageSize
 * até hasNext = false.
 */
export interface TotvsPagedResponse<T> {
  hasNext: boolean;
  items: T[];
}

/**
 * Contexto de aluno (GET /StudentContexts). Um mesmo aluno (RA) aparece em
 * VÁRIOS contextos (um por curso/turma/período letivo) — deduplicar por
 * StudentCode antes de sincronizar.
 *
 * Atenção: os specs não trazem e-mail/nascimento/gênero — isso vem do banco
 * (PPESSOA) no passo de enriquecimento.
 */
export interface RmStudentContext {
  /** RA — código de negócio usado no sourceId do Toddle. */
  StudentCode?: string | number;
  /** Chave interna do RM. Nunca montar/derivar na mão. */
  StudentInternalId?: string;
  StudentName?: string;

  CourseCode?: string | number;
  MajorCode?: string | number;
  ClassCode?: string | number;
  TermCode?: string | number;

  /** Domínios NÃO documentados nos specs — filtrar via RM_ACTIVE_TERM_STATUSES. */
  MajorStatus?: string | number;
  TermStatus?: string | number;

  FatherName?: string;
  MotherName?: string;
  SponsorName?: string;

  /** A API pode devolver campos extras não mapeados. */
  [key: string]: unknown;
}
