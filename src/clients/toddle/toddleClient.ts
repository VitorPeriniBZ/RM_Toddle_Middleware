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
  ) {
    super(message);
    this.name = 'ToddleApiError';
  }
}

/** Quantos sourceIds mandar por chamada no GET (querystring tem limite prático). */
const SOURCE_IDS_PER_REQUEST = 50;

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
      throw new ToddleApiError(
        `Toddle API ${error.config?.method?.toUpperCase()} ${error.config?.url} falhou` +
          (status ? ` (HTTP ${status})` : ''),
        status,
        body,
      );
    });
  }

  /**
   * Busca alunos por sourceId (idempotência: é assim que recuperamos o
   * toddle_id quando a tabela de mapeamento local não conhece o RA).
   * A API aceita sourceIds separados por vírgula; quebramos em chunks e
   * paginamos cada chunk (pageSize entre 100 e 400, paginação obrigatória).
   */
  async getStudentsBySourceIds(sourceIds: string[]): Promise<ToddleStudent[]> {
    const found: ToddleStudent[] = [];

    for (const group of chunk(sourceIds, SOURCE_IDS_PER_REQUEST)) {
      let pageNumber = 1;
      for (;;) {
        const { data } = await this.http.get<ToddleStudentsListResponse>('/public/v2/students', {
          params: {
            sourceIds: group.join(','),
            pageNumber,
            pageSize: env.TODDLE_PAGE_SIZE,
          },
        });

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
    const { data } = await this.http.post<ToddleStudentResponse>('/public/v2/students', payload);
    const student = data?.response?.student;
    if (!student?.id) {
      throw new ToddleApiError('Toddle não retornou o aluno criado', undefined, data);
    }
    return student;
  }

  async updateStudent(toddleId: string, payload: Record<string, unknown>): Promise<void> {
    await this.http.put(`/public/v2/students/${toddleId}`, payload);
  }

  /** Ciclo de vida Toddle: arquivar/desarquivar em vez de excluir. */
  async archiveStudent(toddleId: string): Promise<void> {
    await this.http.put(`/public/v2/students/${toddleId}/archive`);
  }

  async unarchiveStudent(toddleId: string): Promise<void> {
    await this.http.put(`/public/v2/students/${toddleId}/unarchive`);
  }

  /** Year groups da escola — obrigatórios no create de aluno. */
  async getYearGroups(): Promise<ToddleYearGroup[]> {
    const { data } = await this.http.get<ToddleYearGroupsResponse>('/public/v2/year-groups');
    return data?.response?.yearGroups ?? [];
  }
}

export const toddleClient = new ToddleClient();
