import axios, { AxiosError, AxiosInstance } from 'axios';
import { env } from '@rm-toddle/config';
import { chunk } from '@rm-toddle/config';
import { logger } from '@rm-toddle/config';
import {
  ToddleAttendance,
  ToddleGradingPeriod,
  ToddleParent,
  ToddleRoutine,
  ToddleTimetableSlot,
  ToddleTimetableSlotsResponse,
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
    /**
     * Código de transporte do axios (`ECONNRESET`, `EAI_AGAIN`, `ETIMEDOUT`…),
     * presente quando a requisição falhou SEM resposta HTTP. Era descartado
     * até 10/08/2026, e sem ele o log dizia apenas "falhou" — sem pista de que
     * a causa era rede.
     */
    public readonly code?: string,
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

/**
 * Códigos de transporte que NÃO devem ser retentados, apesar de virem sem
 * resposta HTTP. Cancelamento é intencional — retentar desfaria a decisão de
 * quem cancelou.
 */
const CODIGOS_NAO_RETENTAVEIS = new Set(['ERR_CANCELED', 'ECONNABORTED_BY_USER']);

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
      // A mensagem carrega o status OU o código de transporte. Sem isto ela
      // dizia apenas "falhou", e foi o que tornou o diagnóstico de 10/08 lento:
      // 52 falhas de rede eram indistinguíveis de erro de negócio no log e na DLQ.
      const causa = status ? ` (HTTP ${status})` : error.code ? ` (${error.code})` : '';
      throw new ToddleApiError(
        `Toddle API ${error.config?.method?.toUpperCase()} ${error.config?.url} falhou${causa}`,
        status,
        body,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
        error.code,
      );
    });
  }

  /**
   * Executa a chamada retentando o que é transitório: rate limit (429),
   * indisponibilidade (5xx) e **falha de transporte** (sem resposta HTTP).
   * Respeita Retry-After quando a API o envia, senão backoff exponencial.
   *
   * Erros de negócio (4xx que não 429) sobem na hora — retentar um payload
   * inválido só atrasaria a ida para a DLQ.
   *
   * ## Por que falha sem resposta HTTP é retentável (corrigido em 10/08/2026)
   *
   * A condição antiga era `if (status === undefined || !RETRYABLE_STATUS...)`,
   * ou seja: **sem status, desiste na primeira tentativa.** A intenção era não
   * retentar erro de negócio, mas jogou os erros de REDE na mesma vala — e eles
   * são a classe mais retentável que existe.
   *
   * O custo real: nas noites de 08 a 10/08 o sync produziu **52 falhas
   * `PUT falhou` sem código HTTP** contra 15 de rate limit. Cada reset de TCP ou
   * blip de DNS matou um aluno definitivamente, sem usar nenhuma das 5
   * tentativas. Lotes inteiros foram para a DLQ por isso.
   *
   * O discriminador é seguro: o interceptor só produz `ToddleApiError` com
   * `status` indefinido quando o axios **não recebeu resposta alguma** — o que é
   * transporte por definição (DNS, TCP, timeout), nunca regra de negócio, porque
   * erro de negócio sempre vem com status. Erro que NÃO é `ToddleApiError` (bug
   * nosso, falha de parse) continua subindo na hora, como antes.
   */
  private async withRetry<T>(label: string, operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        const apiError = error instanceof ToddleApiError ? error : undefined;
        const status = apiError?.status;
        const code = apiError?.code;

        // Sem resposta HTTP = falha de transporte. Só vale para erro que passou
        // pelo nosso interceptor; qualquer outro sobe imediatamente.
        const falhaDeTransporte =
          apiError !== undefined &&
          status === undefined &&
          !CODIGOS_NAO_RETENTAVEIS.has(code ?? '');

        const retentavel =
          falhaDeTransporte || (status !== undefined && RETRYABLE_STATUS.has(status));

        if (!retentavel || attempt >= MAX_ATTEMPTS) {
          throw error;
        }

        const retryAfter = apiError?.retryAfterSeconds;
        const waitMs = retryAfter !== undefined
          ? retryAfter * 1_000
          : Math.min(2 ** (attempt - 1) * 1_000, MAX_BACKOFF_MS);

        logger.warn(
          { label, status, code, motivo: falhaDeTransporte ? 'transporte' : 'http', attempt, maxAttempts: MAX_ATTEMPTS, waitMs, retryAfter },
          falhaDeTransporte
            ? 'Falha de rede ao falar com o Toddle — aguardando para tentar de novo'
            : 'Toddle indisponível/rate limit — aguardando para tentar de novo',
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

  /**
   * Papéis da organização (`GET /public/v2/org-roles`).
   *
   * O parâmetro `roleLevels` está documentado, mas a API devolve **HTTP 400**
   * com ele (testado em 10/08/2026, `COURSE` e `CLASS`). Sem parâmetro devolve
   * os 16 papéis e filtramos aqui — por isso não há argumento de nível.
   *
   * O `roleId` do nível CLASS é OBRIGATÓRIO para vincular staff a turma, e
   * varia por organização: resolver pelo NOME mantém o middleware white label.
   */
  async listOrgRoles(): Promise<Array<{ roleId: string; roleName: string; roleLevel: string }>> {
    const { data } = await this.withRetry('GET /org-roles', () =>
      this.http.get<{ response?: { roles?: Array<{ roleId: string; roleName: string; roleLevel: string }> } }>(
        '/public/v2/org-roles',
      ),
    );
    return data?.response?.roles ?? [];
  }

  /**
   * TODOS os vínculos usuário↔turma, em páginas por CURSOR (400 por página).
   *
   * Use isto, não `getClassStaff()` em laço: 186 GETs por turma estouraram o
   * rate limit do Toddle em 10/08/2026, e a resposta 429 revelou o que a
   * documentação não diz — **a janela é de 300 segundos**:
   *
   *   "User requests rate limit is reached, please try again after 300 seconds"
   *
   * O backoff do cliente cobre ~15s no máximo, então não há retry que salve:
   * a correção é pedir menos, não esperar mais. E o Toddle põe os 300s só na
   * MENSAGEM, não em header `Retry-After` — o `withRetry` não tem como honrá-lo.
   *
   * `type` distingue 'student' de 'staff'; `isClassArchived`/`isUserArchived`
   * permitem descartar o que já foi arquivado sem uma segunda chamada.
   */
  async listEnrollments(filtros: Record<string, string | number | boolean> = {}): Promise<
    Array<Record<string, unknown>>
  > {
    const todos: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;

    for (let pagina = 1; pagina <= 200; pagina += 1) {
      const { data } = await this.withRetry('GET /enrollments', () =>
        this.http.get<{
          response?: {
            enrollments?: Array<Record<string, unknown>>;
            pageInfo?: { hasNextPage?: boolean; endCursor?: string };
          };
        }>('/public/v2/enrollments', {
          params: { count: 400, ...filtros, ...(cursor ? { cursor } : {}) },
        }),
      );
      const lote = data?.response?.enrollments ?? [];
      todos.push(...lote);

      const info = data?.response?.pageInfo;
      if (!info?.hasNextPage || !info.endCursor) break;
      cursor = info.endCursor;
    }

    return todos;
  }

  /**
   * Staff vinculado a UMA turma. Devolve `courseRole` além da identidade.
   *
   * Para conferir muitas turmas, prefira `listEnrollments()` — este endpoint em
   * laço estoura o rate limit (ver nota lá).
   *
   * Existe de propósito no lugar de deduzir do `GET /courses`, que NÃO traz
   * staff — suas chaves são id, title, curriculumId, isArchived, sourceId,
   * sisId e teacherCourseId.
   */
  async getClassStaff(classId: string): Promise<Array<Record<string, unknown>>> {
    const { data } = await this.withRetry('GET /courses/:id/staffs', () =>
      this.http.get<{ response?: { staff?: Array<Record<string, unknown>> } }>(
        `/public/v2/courses/${classId}/staffs`,
      ),
    );
    return data?.response?.staff ?? [];
  }

  /**
   * Vincula staff a turma.
   *
   * O corpo é `{ staffs: [{ id, roleId }] }` — NÃO `{ staffIds }`, que era o que
   * este método mandava até 10/08/2026 (nunca exercitado: nenhum chamador
   * existia). `roleId` é obrigatório; obtenha-o por `listOrgRoles()` filtrando
   * `roleLevel === 'CLASS'`.
   */
  async addStaffToClass(classId: string, staffs: Array<{ id: string; roleId: string }>): Promise<void> {
    await this.withRetry('PUT /courses/:id/staffs/add', () =>
      this.http.put(`/public/v2/courses/${classId}/staffs/add`, { staffs }),
    );
  }

  /**
   * Desvincula staff de turma. Corpo é `{ staffIds: [...] }` — assimetria real
   * com o `add`, que usa `{ staffs: [{id, roleId}] }`.
   *
   * A existência deste endpoint importa: o vínculo professor↔turma é
   * REVERSÍVEL, ao contrário de quase tudo nesta API (aluno e staff só
   * arquivam; timetable slot e teacher course não têm nem isso).
   */
  async removeStaffFromClass(classId: string, staffIds: string[]): Promise<void> {
    await this.withRetry('PUT /courses/:id/staffs/remove', () =>
      this.http.put(`/public/v2/courses/${classId}/staffs/remove`, { staffIds }),
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
   * Cria um período. ATENÇÃO ao que o endpoint NÃO aceita:
   *
   *  - `startTime`/`endTime`: a hora não mora no período, mora no bell schedule.
   *  - `sourceId`: o Toddle gera o dele ('TDP-<id>'). Portanto NÃO existe
   *    idempotência por chave nossa aqui — reexecutar cria período duplicado.
   *    Quem chama tem de consultar o de-para local antes.
   *
   * `label` precisa ser único, e `type` é 'REGULAR' nos períodos de aula.
   */
  async createPeriod(payload: {
    label: string;
    abbreviation: string;
    type: string;
    curriculumId: string;
    academicYearId: string;
  }): Promise<{ id: string; label: string }> {
    const { data } = await this.withRetry('POST /period', () =>
      this.http.post<{ response?: { period?: { id?: string; label?: string } } }>(
        '/public/v2/period',
        payload,
      ),
    );
    const period = data?.response?.period;
    if (!period?.id) {
      throw new ToddleApiError('Toddle não retornou o período criado', undefined, data);
    }
    return { id: String(period.id), label: String(period.label ?? payload.label) };
  }

  /** Remove um período. Existe DELETE aqui — diferente de aluno e turma. */
  async deletePeriod(periodId: string): Promise<void> {
    await this.withRetry('DELETE /period/:id', () =>
      this.http.delete(`/public/v2/period/${periodId}`),
    );
  }

  /**
   * Cria a grade de horário, ligando cada período à sua faixa.
   * `periods[].startTime`/`endTime` no formato "HH:MM:SS".
   */
  async createBellSchedule(payload: {
    label: string;
    curriculumId: string;
    academicYearId: string;
    periods: Array<{ periodId: string; startTime: string; endTime: string }>;
  }): Promise<string> {
    const { data } = await this.withRetry('POST /bell-schedule', () =>
      this.http.post<{ response?: { isSuccess?: boolean; id?: string } }>(
        '/public/v2/bell-schedule',
        payload,
      ),
    );
    const id = data?.response?.id;
    if (!id) {
      throw new ToddleApiError('Toddle não retornou a grade criada', undefined, data);
    }
    return String(id);
  }

  /** Remove uma grade de horário. */
  async deleteBellSchedule(bellScheduleId: string): Promise<void> {
    await this.withRetry('DELETE /bell-schedule/:id', () =>
      this.http.delete(`/public/v2/bell-schedule/${bellScheduleId}`),
    );
  }

  /**
   * Currículos da organização. O nome vem em DOIS campos e os dois importam:
   * `title` é o código do programa ('UBD', 'IB_MYP') e `label` é o nome de
   * exibição ('Independent Programme'). Não existe campo `name`.
   *
   * Traz também `attendanceVersion` e `timetableVersion`, que determinam qual
   * modelo de chamada e de grade aquele currículo usa.
   */
  async listCurriculums(): Promise<
    Array<{
      id: string;
      title?: string;
      label?: string;
      setupType?: string;
      attendanceVersion?: string;
      timetableVersion?: string;
      organizationName?: string;
    }>
  > {
    const { data } = await this.withRetry('GET /curriculums', () =>
      this.http.get<{
        response?: {
          curriculums?: Array<{
            id: string;
            title?: string;
            label?: string;
            setupType?: string;
            attendanceVersion?: string;
            timetableVersion?: string;
            organizationName?: string;
          }>;
        };
      }>('/public/v2/curriculums'),
    );
    return data?.response?.curriculums ?? [];
  }

  /**
   * Slots da grade — qual turma ocupa qual período em qual dia.
   *
   * A resposta vem EXPANDIDA POR DATA: um slot semanal recorrente aparece uma
   * vez por ocorrência dentro da janela consultada. Para saber se um slot
   * existe, consulte uma semana representativa e olhe a tupla
   * (courseId, periodId, weekday) — não conte linhas.
   *
   * `curriculumIds` vai como array JSON; `academicYearId` é SINGULAR aqui
   * (diferente de /periods e /bell-schedule, que usam `academicYearIds` plural).
   */
  async listTimetableSlots(params: {
    curriculumId: string;
    academicYearId: string;
    startDate: string;
    endDate: string;
    courseIds?: string[];
  }): Promise<ToddleTimetableSlot[]> {
    const slots: ToddleTimetableSlot[] = [];
    let cursor: string | undefined;

    for (;;) {
      const query: Record<string, string | number> = {
        curriculumIds: JSON.stringify([params.curriculumId]),
        academicYearId: params.academicYearId,
        startDate: params.startDate,
        endDate: params.endDate,
        count: ATTENDANCE_PAGE_SIZE,
      };
      if (cursor) query.cursor = cursor;
      if (params.courseIds?.length) query.courseIds = JSON.stringify(params.courseIds);

      const { data } = await this.withRetry('GET /timetable-slots', () =>
        this.http.get<ToddleTimetableSlotsResponse>('/public/v2/timetable-slots', { params: query }),
      );

      slots.push(...(data?.response?.edges ?? []));
      const info = data?.response?.pageInfo;
      if (!info?.hasNextPage || !info?.endCursor) break;
      cursor = info.endCursor;
    }
    return slots;
  }

  /**
   * Cria um slot da grade. Espelha uma linha de `SHorarioTurma` do RM.
   *
   * DUAS COISAS QUE LIMITAM O USO:
   *
   *  - A resposta é só `{ isSuccess: true }`, SEM id. Não há como guardar um
   *    de-para slot ↔ horário do RM; a identificação é a tupla
   *    (courseId, periodId, weekDay), recuperável pelo GET.
   *  - NÃO existe DELETE de timetable-slot na API (só POST e GET). Existe
   *    `isEnabled`, mas desligar depois não foi verificado. Trate cada criação
   *    como permanente.
   *
   * `applicableTill` tem de cair DENTRO do ano acadêmico, senão a API recusa com
   * "Applicable till should be within academic year start and end date". O ano
   * letivo do RM pode passar do ano acadêmico do Toddle — quem chama decide o
   * que fazer com a sobra, e não deve limitar em silêncio.
   */
  async createTimetableSlot(payload: {
    curriculumId: string;
    academicYearId: string;
    courseId: string;
    weekDay: number;
    periodId: string;
    startTime?: string;
    endTime?: string;
    applicableFrom?: string;
    applicableTill?: string;
    isEnabled?: boolean;
  }): Promise<void> {
    const { data } = await this.withRetry('POST /timetable-slots', () =>
      this.http.post<{ response?: { isSuccess?: boolean } }>('/public/v2/timetable-slots', payload),
    );
    if (data?.response?.isSuccess !== true) {
      throw new ToddleApiError('POST /timetable-slots não confirmou isSuccess', undefined, data);
    }
  }

  /**
   * Routine: qual grade de horário vale em qual dia, para quais séries.
   *
   * É o nível que faltava. Um `timetable-slot` só materializa se a routine do
   * currículo tiver `bellSchedulesMapping` — sem ele, `POST /timetable-slots`
   * devolve `{ isSuccess: true }` e não cria nada (medido em 04/08/2026).
   */
  async getRoutine(routineId: string): Promise<ToddleRoutine> {
    const { data } = await this.withRetry('GET /routine/:id', () =>
      this.http.get<{ response?: { routine?: ToddleRoutine } }>(`/public/v2/routine/${routineId}`),
    );
    const routine = data?.response?.routine;
    if (!routine) throw new ToddleApiError('Toddle não retornou a routine', undefined, data);
    return routine;
  }

  async listRoutines(curriculumId: string, academicYearId: string): Promise<ToddleRoutine[]> {
    const { data } = await this.withRetry('GET /routines', () =>
      this.http.get<{ response?: { routines?: ToddleRoutine[] } }>('/public/v2/routines', {
        params: {
          curriculumIds: JSON.stringify([curriculumId]),
          academicYearIds: JSON.stringify([academicYearId]),
          count: 100,
        },
      }),
    );
    return data?.response?.routines ?? [];
  }

  /**
   * Cria uma routine. `bellScheduleMap` é OBRIGATÓRIO — e é o campo cuja ausência
   * deixa a grade inerte. No modo `OPERATIONAL_DAYS` cada entrada é
   * `{ weekday, bellScheduleId }`.
   *
   * ATENÇÃO: as séries (`gradeIds`) podem já pertencer a outra routine. Não está
   * documentado se o Toddle compartilha ou MOVE a série. Confira a routine antiga
   * depois de criar.
   */
  async createRoutine(payload: {
    label: string;
    gradeIds: string[];
    routineMode: string;
    startDate: string;
    endDate: string;
    curriculumId: string;
    academicYearId: string;
    countHolidayAsRotationDay: boolean;
    bellScheduleMap: Array<{ weekday: number; bellScheduleId: string }>;
  }): Promise<string> {
    const { data } = await this.withRetry('POST /routine', () =>
      this.http.post<{ response?: { routine?: { id?: string }; id?: string } }>(
        '/public/v2/routine',
        payload,
      ),
    );
    const id = data?.response?.routine?.id ?? data?.response?.id;
    if (!id) throw new ToddleApiError('Toddle não retornou a routine criada', undefined, data);
    return String(id);
  }

  /** Remove uma routine. Existe DELETE aqui — o desfazer é real. */
  async deleteRoutine(routineId: string): Promise<void> {
    await this.withRetry('DELETE /routine/:id', () =>
      this.http.delete(`/public/v2/routine/${routineId}`),
    );
  }

  /**
   * Altera uma routine — na prática, o único jeito de dar `bellScheduleMap` a uma
   * routine que não tem, e com isso fazer os timetable slots materializarem.
   *
   * A ROTA É `PUT`, não `POST`. A documentação diz `POST /routine/:id` e está
   * errada: `POST` devolve "Route Not Found". Medido em 04/08/2026.
   *
   * É SUBSTITUIÇÃO, NÃO REMENDO: `label`, `gradeIds`, as datas e
   * `countHolidayAsRotationDay` são obrigatórios junto do `bellScheduleMap`.
   * Mandar só o mapa devolve "Route Not Found". Leia a routine antes e reenvie os
   * campos como estão, senão você apaga configuração sem querer.
   *
   * `routineMode` NÃO pode ir no payload ("Routine mode cannot be updated").
   *
   * `rotationDays: []` e `dayPatterns: []` SÃO OBRIGATÓRIOS, ao contrário do que a
   * doc diz (ela os declara exclusivos de `ROTATION_CYCLE`). Omiti-los faz o
   * backend estourar com `Cannot read properties of undefined (reading 'map')` —
   * erro de servidor disfarçado de HTTP 400. Por isso este método os injeta.
   *
   * ─── É IRREVERSÍVEL ─────────────────────────────────────────────────────────
   *
   * `bellScheduleMap: []` é recusado ("Invalid or missing Bell Schedule"), e o
   * campo é obrigatório também no create. Portanto uma routine COM mapeamento não
   * volta a ficar SEM pela API — nem por update, nem apagando e recriando. Dá para
   * trocar de grade; não para voltar a "nenhuma".
   *
   * `weekday` usa a convenção do TODDLE: 1 = segunda (o RM usa 2). E o mapa tem de
   * cobrir TODOS os dias operacionais da organização — que são 1 a 5 aqui, e não
   * há endpoint que os liste.
   */
  async updateRoutine(
    routineId: string,
    payload: {
      label: string;
      gradeIds: string[];
      startDate: string;
      endDate: string;
      countHolidayAsRotationDay: boolean;
      bellScheduleMap: Array<{ weekday: number; bellScheduleId: string }>;
    },
  ): Promise<void> {
    await this.withRetry('PUT /routine/:id', () =>
      this.http.put(`/public/v2/routine/${routineId}`, {
        ...payload,
        // Ver a nota acima: o servidor percorre estes campos mesmo em
        // OPERATIONAL_DAYS, então precisam existir.
        rotationDays: [],
        dayPatterns: [],
      }),
    );
  }

  /**
   * Responsáveis. `children` é array de studentId, então um responsável com vários
   * filhos é UMA chamada.
   *
   * `POST /parents` NÃO aceita `sourceId` (o campo aparece na resposta, sempre
   * nulo). Mas ao contrário de período, o `GET /parents` devolve `email` e
   * `children`, então a idempotência é recuperável pela API — o e-mail é a
   * identidade.
   *
   * NÃO existe DELETE. Só POST, PUT e GET: criar parent é dar acesso ao LMS, e
   * desfazer depende de PUT ou do portal.
   */
  async listParents(): Promise<ToddleParent[]> {
    const { data } = await this.withRetry('GET /parents', () =>
      this.http.get<{ response?: { parents?: ToddleParent[] } }>('/public/v2/parents'),
    );
    return data?.response?.parents ?? [];
  }

  async createParent(payload: {
    firstName: string;
    lastName: string;
    email: string;
    children: string[];
    relationships?: Array<{ childId: string; relationship: string }>;
    gender?: string;
  }): Promise<{ id: string; email?: string }> {
    const { data } = await this.withRetry('POST /parents', () =>
      this.http.post<{ response?: { parent?: { id?: string | number; email?: string } } }>(
        '/public/v2/parents',
        payload,
      ),
    );
    const parent = data?.response?.parent;
    if (!parent?.id) {
      throw new ToddleApiError('Toddle não retornou o responsável criado', undefined, data);
    }
    return { id: String(parent.id), email: parent.email };
  }

  /**
   * Grading periods (T1, T2, T3) — o `gradingPeriodId` que o POST /term-grades
   * exige.
   *
   * A resposta é um ARRAY DIRETO em `response`, não um objeto com chave nomeada
   * como nos outros endpoints. E `curriculumProgramId` vai SOLTO na querystring,
   * não como array JSON.
   */
  async listGradingPeriods(curriculumProgramId: string): Promise<ToddleGradingPeriod[]> {
    const { data } = await this.withRetry('GET /grading-periods', () =>
      this.http.get<{ response?: ToddleGradingPeriod[] }>('/public/v2/grading-periods', {
        params: { curriculumProgramId },
      }),
    );
    return data?.response ?? [];
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
