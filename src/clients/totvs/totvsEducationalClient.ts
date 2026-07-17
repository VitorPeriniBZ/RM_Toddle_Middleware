import axios, { AxiosInstance } from 'axios';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { RmStudentContext, TotvsPagedResponse } from './types';

/**
 * Cliente da API TOTVS RM Educacional (TTALK): {host}/api/educational/v1.
 * Autenticação via header Authorization — o valor completo vem do .env
 * (o esquema Basic/Bearer depende do ambiente do cliente).
 */
class TotvsEducationalClient {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: `${env.TOTVS_RM_HOST}/api/educational/v1`,
      timeout: 60_000,
      headers: {
        Authorization: env.TOTVS_RM_AUTH_HEADER,
        Accept: 'application/json',
      },
    });
  }

  /** Uma página de contextos de aluno (page começa em 1). */
  async getStudentContextsPage(
    page: number,
    pageSize = env.TOTVS_RM_PAGE_SIZE,
  ): Promise<TotvsPagedResponse<RmStudentContext>> {
    const { data } = await this.http.get<TotvsPagedResponse<RmStudentContext>>(
      '/StudentContexts',
      { params: { page, pageSize } },
    );
    return {
      hasNext: Boolean(data?.hasNext),
      items: Array.isArray(data?.items) ? data.items : [],
    };
  }

  /**
   * Async generator que percorre TODAS as páginas de /StudentContexts.
   * Segue o contrato TTALK: incrementa page enquanto hasNext = true.
   * Guarda contra loop infinito: página vazia com hasNext = true encerra.
   */
  async *iterateStudentContexts(
    pageSize = env.TOTVS_RM_PAGE_SIZE,
  ): AsyncGenerator<RmStudentContext[], void, void> {
    let page = 1;
    for (;;) {
      const { hasNext, items } = await this.getStudentContextsPage(page, pageSize);
      logger.debug({ page, count: items.length, hasNext }, 'RM /StudentContexts página lida');

      if (items.length > 0) yield items;

      if (!hasNext) return;
      if (items.length === 0) {
        logger.warn({ page }, 'RM devolveu página vazia com hasNext=true — encerrando paginação');
        return;
      }
      page += 1;
    }
  }
}

export const totvsClient = new TotvsEducationalClient();
