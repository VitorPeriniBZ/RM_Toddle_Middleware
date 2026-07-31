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
  /**
   * Curso/matriz do aluno (SHABILITACAOFILIAL). É O QUE DETERMINA O CURRÍCULO
   * do Toddle: a EAV tem dois programas (IB_MYP e UBD/Independent) cujas
   * escadas de série se sobrepõem — 10º ano existe como 'Grade 10' no UBD e
   * como 'Year 5' no MYP. Sem curso, o de-para turma -> year group é escolha
   * entre duas escadas sem critério.
   */
  CourseName?: string;
  /** SMATRICPL.IDHABILITACAOFILIAL — a matriz aplicada, chave estável do curso. */
  AppliedMatrixId?: string;
  /** STIPOCURSO.NOME. Na base da EAV vem 'Ensino Básico' em tudo — pouco útil. */
  EducationLevel?: string;
  MajorCode?: string | number;
  ClassCode?: string | number;
  /** Nome da turma (ex.: '10th grade A - 1ª série') — carrega a série no texto. */
  ClassName?: string;
  /** Campus (CODFILIAL). Escopo da integração controlado por RM_CODFILIAL. */
  BranchCode?: string;
  TermCode?: string | number;

  /** Domínios NÃO documentados nos specs — filtrar via RM_ACTIVE_TERM_STATUSES. */
  MajorStatus?: string | number;
  TermStatus?: string | number;

  /**
   * Flag de matrícula ativa vindo do PRÓPRIO RM (SSTATUS.PLATIVO, "indica se
   * está ativo no P. Letivo"), materializado como 'S'/'N'. Quando presente,
   * dispensa adivinhar códigos de status em RM_ACTIVE_TERM_STATUSES — é a
   * definição de "ativo" que a escola já mantém no RM.
   */
  IsActiveTerm?: string;
  /** Descrição legível do status (ex.: 'Matriculado', 'Transferido') — só log. */
  TermStatusName?: string;

  FatherName?: string;
  MotherName?: string;
  SponsorName?: string;

  /** A API pode devolver campos extras não mapeados. */
  [key: string]: unknown;
}
