import axios, { AxiosError, AxiosInstance } from 'axios';
import { env } from '../../config/env';
import { chunk } from '../../utils/array';
import { logger } from '../../utils/logger';
import {
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
}

export const toddleClient = new ToddleClient();
