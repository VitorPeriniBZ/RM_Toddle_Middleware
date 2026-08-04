import axios, { AxiosError, AxiosInstance } from 'axios';
import { env } from '@rm-toddle/config';
import { chunk } from '@rm-toddle/config';
import { logger } from '@rm-toddle/config';
import {
  ToddleAttendance,
  ToddleBellSchedule,
  ToddleBellScheduleResponse,
  ToddleAttendanceCode,
  ToddleAttendanceCodesResponse,
  ToddleAttendanceListResponse,
  ToddleStudent,
  ToddleStudentResponse,
  ToddleStudentsListResponse,
  ToddleYearGroup,
  ToddleYearGroupsResponse,
} from './types';

/** Erro enriquecido com status + corpo da resposta (útil na DLQ). */
export class ToddleApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
    /** Valor do header Retry-After, em segundos, quando a API o envia. */
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ToddleApiError';
  }
}

/** Quantos sourceIds mandar por chamada no GET (querystring tem limite prático). */
const SOURCE_IDS_PER_REQUEST = 50;

/** Tamanho de página do GET /attendance (paginação por cursor). */
const ATTENDANCE_PAGE_SIZE = 400;

/**
 * Status que merecem nova tentativa: 429 é rate limit (os limites do Toddle NÃO
 * são documentados — observamos 429 em 2026-07-31 com 5 req/s) e 5xx é
 * indisponibilidade temporária. Retentar aqui, no cliente, evita que uma única
 * resposta transitória derrube o lote inteiro para a DLQ.
 */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 16_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cliente da Toddle Open API V2 (https://{regiao}-production-apis.toddleapp.com).
 * - Auth: Authorization: Bearer <token>
 * - Todo ID é String
 * - Ciclo de vida: PUT /:id/archive (não existe DELETE)
 */
export class ToddleClient {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: env.TODDLE_BASE_URL,
      timeout: 60_000,
      headers: {
        Authorization: `Bearer ${env.TODDLE_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });

    this.http.interceptors.response.use(undefined, (error: AxiosError) => {
      const status = error.response?.status;
      const body = error.response?.data;
      const rawRetryAfter = error.response?.headers?.['retry-after'];
      const retryAfter = Number(rawRetryAfter);
      throw new ToddleApiError(
        `Toddle API ${error.config?.method?.toUpperCase()} ${error.config?.url} falhou` +
          (status ? ` (HTTP ${status})` : ''),
        status,
        body,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      );
    });
  }

  /**
   * Executa a chamada retentando rate limit (429) e indisponibilidade (5xx),
   * respeitando Retry-After quando a API o envia e caindo em backoff
   * exponencial quando não. Erros de negócio (4xx que não 429) sobem na hora —
   * retentar um payload inválido só atrasaria a ida para a DLQ.
   */
  private async withRetry<T>(label: string, operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        const status = error instanceof ToddleApiError ? error.status : undefined;
        if (status === undefined || !RETRYABLE_STATUS.has(status) || attempt >= MAX_ATTEMPTS) {
          throw error;
        }

        const retryAfter = error instanceof ToddleApiError ? error.retryAfterSeconds : undefined;
        const waitMs = retryAfter !== undefined
          ? retryAfter * 1_000
          : Math.min(2 ** (attempt - 1) * 1_000, MAX_BACKOFF_MS);

        logger.warn(
          { label, status, attempt, maxAttempts: MAX_ATTEMPTS, waitMs, retryAfter },
          'Toddle indisponível/rate limit — aguardando para tentar de novo',
        );
        await sleep(waitMs);
      }
    }
  }

  /**
   * Busca alunos por sourceId (idempotência: é assim que recuperamos o
   * toddle_id quando a tabela de mapeamento local não conhece o RA).
   *
   * ATENÇÃO: `sourceIds` NÃO é CSV — a API exige um ARRAY serializado em JSON
   * na querystring (`sourceIds=["A","B"]`). CSV ou `sourceIds[]=` devolvem
   * HTTP 400 ("Incorrect Data Input" / "sourceIds must be an array").
   * Quebramos em chunks e paginamos cada chunk (pageSize entre 100 e 400,
   * paginação obrigatória).
   */
  async getStudentsBySourceIds(sourceIds: string[]): Promise<ToddleStudent[]> {
    const found: ToddleStudent[] = [];

    for (const group of chunk(sourceIds, SOURCE_IDS_PER_REQUEST)) {
      let pageNumber = 1;
      for (;;) {
        const { data } = await this.withRetry('GET /students', () =>
          this.http.get<ToddleStudentsListResponse>('/public/v2/students', {
            params: {
              sourceIds: JSON.stringify(group),
              pageNumber,
              pageSize: env.TODDLE_PAGE_SIZE,
            },
          }),
        );

        const students = data?.response?.students ?? [];
        found.push(...students);
        logger.debug({ pageNumber, count: students.length }, 'Toddle GET /students página lida');

        // Última página: veio menos que o pageSize pedido.
        if (students.length < env.TODDLE_PAGE_SIZE) break;
        pageNumber += 1;
      }
    }

    return found;
  }

  /**
   * Uma página do roster da organização, sem filtro de sourceId.
   *
   * ATENÇÃO: alunos ARQUIVADOS não vêm aqui — a API não os devolve em nenhum
   * GET e não há parâmetro para incluí-los. Portanto esta listagem responde
   * "quem está ativo no destino", nunca "quem existe no destino". Para saber de
   * arquivados, a fonte é a id_mapping.
   */
  async listStudentsPage(pageNumber: number): Promise<ToddleStudent[]> {
    const { data } = await this.withRetry('GET /students (página)', () =>
      this.http.get<ToddleStudentsListResponse>('/public/v2/students', {
        params: { pageNumber, pageSize: env.TODDLE_PAGE_SIZE },
      }),
    );
    return data?.response?.students ?? [];
  }

  async createStudent(payload: Record<string, unknown>): Promise<ToddleStudent> {
    const { data } = await this.withRetry('POST /students', () =>
      this.http.post<ToddleStudentResponse>('/public/v2/students', payload),
    );
    const student = data?.response?.student;
    if (!student?.id) {
      throw new ToddleApiError('Toddle não retornou o aluno criado', undefined, data);
    }
    return student;
  }

  async updateStudent(toddleId: string, payload: Record<string, unknown>): Promise<void> {
    await this.withRetry('PUT /students/:id', () =>
      this.http.put(`/public/v2/students/${toddleId}`, payload),
    );
  }

  /** Ciclo de vida Toddle: arquivar/desarquivar em vez de excluir. */
  async archiveStudent(toddleId: string): Promise<void> {
    await this.withRetry('PUT /students/:id/archive', () =>
      this.http.put(`/public/v2/students/${toddleId}/archive`),
    );
  }

  async unarchiveStudent(toddleId: string): Promise<void> {
    await this.withRetry('PUT /students/:id/unarchive', () =>
      this.http.put(`/public/v2/students/${toddleId}/unarchive`),
    );
  }

  /**
   * Year groups da escola — obrigatórios no create de aluno.
   *
   * SEM `curriculumId` a API devolve a org INTEIRA, achatando os currículos:
   * a EAV tem dois, e os nomes colidem entre eles (existe "Year 1" nos dois,
   * com ids diferentes) — a resposta não traz campo de currículo para
   * desempatar. Passe `curriculumId` sempre que for montar de-para.
   */
  async getYearGroups(curriculumId?: string): Promise<ToddleYearGroup[]> {
    const { data } = await this.withRetry('GET /year-groups', () =>
      this.http.get<ToddleYearGroupsResponse>('/public/v2/year-groups', {
        params: curriculumId ? { curriculumId } : undefined,
      }),
    );
    return data?.response?.yearGroups ?? [];
  }

  // -------------------------------------------------------------------------
  // Staff (professores)
  // -------------------------------------------------------------------------

  /** Uma página do staff. Arquivados NÃO vêm (mesma regra dos alunos). */
  async listStaffPage(pageNumber: number): Promise<Array<Record<string, unknown>>> {
    const { data } = await this.withRetry('GET /staff', () =>
      this.http.get<{ response?: { staff?: Array<Record<string, unknown>> } }>('/public/v2/staff', {
        params: { pageNumber, pageSize: 100 },
      }),
    );
    return data?.response?.staff ?? [];
  }

  /**
   * Cria staff. O Toddle EXIGE `email` e o usa como IDENTIDADE — e-mail errado
   * gera conta inacessível que só pode ser arquivada, nunca excluída.
   */
  async createStaff(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { data } = await this.withRetry('POST /staff', () =>
      this.http.post<{ response?: Record<string, unknown> }>('/public/v2/staff', payload),
    );
    return data?.response ?? {};
  }

  async archiveStaff(staffId: string): Promise<void> {
    await this.withRetry('PUT /staff/:id/archive', () =>
      this.http.put(`/public/v2/staff/${staffId}/archive`),
    );
  }

  // -------------------------------------------------------------------------
  // TeacherCourse e Class (turmas)
  // -------------------------------------------------------------------------

  /**
   * Cria TeacherCourse (disciplina/nível). `academicCourseId` é OBRIGATÓRIO — a
   * API responde "Academic Course ID is required. Teacher courses can only be
   * created when linked to an academic course." E o vínculo é DEFINITIVO: o
   * PUT de update só aceita title/description, e não existe DELETE.
   */
  async createTeacherCourse(payload: Record<string, unknown>): Promise<string> {
    const { data } = await this.withRetry('POST /teacher-courses', () =>
      this.http.post<{ response?: { teacherCourseId?: string } }>('/public/v2/teacher-courses', payload),
    );
    const id = data?.response?.teacherCourseId;
    if (!id) throw new ToddleApiError('Toddle não devolveu teacherCourseId', undefined, data);
    return id;
  }

  /** Cria Class (o "course" da API V2). Exige teacherCourseId + curriculumId. */
  async createClass(payload: Record<string, unknown>): Promise<string> {
    const { data } = await this.withRetry('POST /courses', () =>
      this.http.post<{ response?: { course?: { id?: string } } }>('/public/v2/courses', payload),
    );
    const id = data?.response?.course?.id;
    if (!id) throw new ToddleApiError('Toddle não devolveu o id da class', undefined, data);
    return id;
  }

  async listClasses(): Promise<Array<Record<string, unknown>>> {
    const { data } = await this.withRetry('GET /courses', () =>
      this.http.get<{ response?: { courses?: Array<Record<string, unknown>> } }>('/public/v2/courses'),
    );
    return data?.response?.courses ?? [];
  }

  async addStudentsToClass(classId: string, studentIds: string[]): Promise<void> {
    await this.withRetry('PUT /courses/:id/students/add', () =>
      this.http.put(`/public/v2/courses/${classId}/students/add`, { studentIds }),
    );
  }

  async addStaffToClass(classId: string, staffIds: string[]): Promise<void> {
    await this.withRetry('PUT /courses/:id/staffs/add', () =>
      this.http.put(`/public/v2/courses/${classId}/staffs/add`, { staffIds }),
    );
  }

  async archiveClass(classId: string): Promise<void> {
    await this.withRetry('PUT /courses/:id/archive', () =>
      this.http.put(`/public/v2/courses/${classId}/archive`),
    );
  }

  /**
   * Frequência lançada no Toddle — a origem da via Toddle -> RM.
   *
   * Paginação por CURSOR, não por pageNumber: a resposta traz
   * `pageInfo.endCursor`/`hasNextPage` e os registros em `edges`. Diferente de
   * /students, que usa pageNumber.
   *
   * ATENÇÃO a três coisas medidas na estrutura da resposta:
   *
   * 1. `courseId` e `periodId` podem vir NULOS — é o caso da chamada de homeroom
   *    (`masterAttendance`). Sem curso não há IDTURMADISC, e o registro não pode
   *    ser projetado. Isso é recusa, nunca chute.
   * 2. `startTime`/`endTime` podem vir nulos ou como a STRING "null".
   * 3. `isDeleted` marca exclusão em vez de o registro desaparecer.
   *
   * As datas são strings "YYYY-MM-DD" em todos os filtros.
   */
  async listAttendance(filtros: {
    startDate?: string;
    endDate?: string;
    courseIds?: string[];
    studentIds?: string[];
    modifiedSince?: string;
    modifiedTill?: string;
    /** Teto de segurança: aborta se a origem devolver mais que isto. */
    maxRecords?: number;
  } = {}): Promise<ToddleAttendance[]> {
    const registros: ToddleAttendance[] = [];
    const teto = filtros.maxRecords ?? Infinity;
    let cursor: string | undefined;

    for (;;) {
      const params: Record<string, string | number> = { count: ATTENDANCE_PAGE_SIZE };
      if (cursor) params.cursor = cursor;
      if (filtros.startDate) params.startDate = filtros.startDate;
      if (filtros.endDate) params.endDate = filtros.endDate;
      if (filtros.modifiedSince) params.modifiedSince = filtros.modifiedSince;
      if (filtros.modifiedTill) params.modifiedTill = filtros.modifiedTill;
      // Mesma armadilha do sourceIds: array vai SERIALIZADO EM JSON, não CSV.
      if (filtros.courseIds?.length) params.courseIds = JSON.stringify(filtros.courseIds);
      if (filtros.studentIds?.length) params.studentIds = JSON.stringify(filtros.studentIds);

      const { data } = await this.withRetry('GET /attendance', () =>
        this.http.get<ToddleAttendanceListResponse>('/public/v2/attendance', { params }),
      );

      const pagina = data?.response?.edges ?? [];
      registros.push(...pagina);
      logger.debug(
        { lidos: pagina.length, acumulado: registros.length, totalCount: data?.response?.totalCount },
        'Toddle GET /attendance página lida',
      );

      if (registros.length > teto) {
        throw new ToddleApiError(
          `GET /attendance devolveu mais de ${teto} registros — abortando antes de processar. ` +
            'Estreite a janela de datas ou a lista de cursos. Este tenant tem dezenas de ' +
            'milhares de registros de DEMONSTRAÇÃO, e volume inesperado é sinal de escopo errado.',
        );
      }

      const info = data?.response?.pageInfo;
      if (!info?.hasNextPage || !info?.endCursor) break;
      cursor = info.endCursor;
    }

    return registros;
  }

  /** Códigos de chamada configurados (Present, Absent, Late, …) por currículo/ano. */
  async listAttendanceCodes(academicYearIds?: string[]): Promise<ToddleAttendanceCode[]> {
    const codigos: ToddleAttendanceCode[] = [];
    let cursor: string | undefined;

    for (;;) {
      const params: Record<string, string | number> = { count: ATTENDANCE_PAGE_SIZE };
      if (cursor) params.cursor = cursor;
      if (academicYearIds?.length) params.academicYearIds = JSON.stringify(academicYearIds);

      const { data } = await this.withRetry('GET /attendance-codes', () =>
        this.http.get<ToddleAttendanceCodesResponse>('/public/v2/attendance-codes', { params }),
      );

      codigos.push(...(data?.response?.edges ?? []));
      const info = data?.response?.pageInfo;
      if (!info?.hasNextPage || !info?.endCursor) break;
      cursor = info.endCursor;
    }

    return codigos;
  }

  /**
   * Anos acadêmicos da organização. Necessários porque /periods e /bell-schedule
   * EXIGEM `academicYearIds` — sem o parâmetro os dois devolvem HTTP 400
   * ("Route Not Found" no caso do bell-schedule, o que engana).
   */
  async listAcademicYears(): Promise<Array<Record<string, unknown>>> {
    const { data } = await this.withRetry('GET /academic-years', () =>
      this.http.get<{ response?: { academicYears?: Array<Record<string, unknown>> } }>(
        '/public/v2/academic-years',
      ),
    );
    return data?.response?.academicYears ?? [];
  }

  /**
   * Grades de horário (bell schedules) — a ÚNICA fonte de hora de aula na API.
   *
   * Medido em 04/08/2026: o `startTime`/`endTime` do registro de frequência vem
   * NULO (800 de 800 na amostra). Quem carrega a hora é o `periodSet` do bell
   * schedule, no formato `{ periodId, startTime, endTime }`.
   *
   * Duas armadilhas:
   *  - A rota é SINGULAR. `/bell-schedules` devolve "Route Not Found" com HTTP
   *    400, o que parece "não existe" e não é.
   *  - `academicYearIds` é obrigatório e vai como ARRAY SERIALIZADO EM JSON.
   *
   * ATENÇÃO ao usar: o MESMO periodId aparece em bell schedules diferentes com
   * horas diferentes (9 dos 57 medidos). O periodId sozinho NÃO determina a
   * hora — quem resolve precisa tratar conflito como ambiguidade, não escolher.
   */
  async listBellSchedules(academicYearIds: string[]): Promise<ToddleBellSchedule[]> {
    if (academicYearIds.length === 0) {
      throw new ToddleApiError(
        'listBellSchedules exige academicYearIds — sem o parâmetro a API devolve HTTP 400.',
      );
    }

    const todas: ToddleBellSchedule[] = [];
    for (const ay of academicYearIds) {
      let cursor: string | undefined;
      for (;;) {
        const params: Record<string, string | number> = {
          academicYearIds: JSON.stringify([ay]),
          count: ATTENDANCE_PAGE_SIZE,
        };
        if (cursor) params.cursor = cursor;

        const { data } = await this.withRetry('GET /bell-schedule', () =>
          this.http.get<ToddleBellScheduleResponse>('/public/v2/bell-schedule', { params }),
        );

        todas.push(...(data?.response?.bellSchedules ?? []));
        const info = data?.response?.pageInfo;
        if (!info?.hasNextPage || !info?.endCursor) break;
        cursor = info.endCursor;
      }
    }
    return todas;
  }

  /**
   * Confirma que o token aponta para a organização declarada em TODDLE_ORG_ID e
   * ABORTA se divergir. Chamar UMA vez, antes de qualquer escrita.
   *
   * Por que existe: a estrutura acadêmica do Toddle é somente leitura na API e é
   * criada pela escola no portal, então os ids guardados na id_mapping pertencem
   * a UMA organização. Trocar o token sem trocar o de-para faria o sync escrever
   * noutra organização reusando ids que não existem lá — e silenciosamente,
   * porque nada na resposta obriga a conferir. A organização vem no payload de
   * /year-groups (campo organizationId), que já lemos de todo jeito.
   */
  async assertTargetOrganization(): Promise<string> {
    const yearGroups = await this.getYearGroups();
    const orgIds = [...new Set(
      yearGroups
        .map((yg) => (typeof yg.organizationId === 'string' ? yg.organizationId : undefined))
        .filter((id): id is string => Boolean(id)),
    )];

    if (orgIds.length === 0) {
      throw new ToddleApiError(
        'Não foi possível identificar a organização do Toddle: /year-groups não devolveu ' +
          'organizationId. A estrutura acadêmica pode não estar criada nesta organização.',
      );
    }
    if (orgIds.length > 1) {
      throw new ToddleApiError(
        `/year-groups devolveu mais de uma organização (${orgIds.join(', ')}) — inesperado; ` +
          'o token deveria estar restrito a uma.',
      );
    }
    if (orgIds[0] !== env.TODDLE_ORG_ID) {
      throw new ToddleApiError(
        `Organização divergente: o token resolve para ${orgIds[0]}, mas TODDLE_ORG_ID declara ` +
          `${env.TODDLE_ORG_ID}. Abortando ANTES de qualquer escrita — os mapeamentos da ` +
          'id_mapping pertencem à organização declarada e não valem na outra.',
      );
    }

    logger.info({ organizationId: orgIds[0] }, 'Organização do Toddle confirmada');
    return orgIds[0];
  }
}

export const toddleClient = new ToddleClient();
