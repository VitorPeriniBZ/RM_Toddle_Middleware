import { createHash } from 'node:crypto';
import { env } from './env';

/**
 * Impressão digital da configuração que define ESCOPO e DESTINO de um sync.
 *
 * POR QUE ISTO EXISTE: um job carrega dados montados sob a configuração vigente
 * no momento do extract. Se a configuração mudar antes do job ser processado, ele
 * aplica uma decisão que ninguém mais tomaria.
 *
 * Aconteceu de verdade em 2026-08-04: jobs do dia 31/07, montados quando
 * RM_CODFILIAL estava vazio (todos os campi), ficaram parados na fila e
 * executaram dias depois — tentando criar no Toddle alunos do campus 1, que já
 * havia saído de escopo. Só não criaram porque o sourceId dos arquivados barrou.
 * Não é aceitável depender dessa coincidência.
 *
 * O QUE ENTRA no hash: apenas o que INVALIDA um job em andamento.
 *   - TENANT_SLUG        outra escola
 *   - RM_CODFILIAL       outro escopo de campus
 *   - TODDLE_ORG_ID      outra organização de destino
 *   - RM_SENTENCA_*      outra fonte de dados
 *   - RM_CODCOLIGADA     outra coligada
 *   - RM_CODPERLET       outro ano letivo
 *   - SOURCE_ID_PREFIX   muda o contrato de identidade entre os sistemas
 *
 * O QUE NÃO ENTRA: nada que seja só de desempenho ou operação
 * (SYNC_BATCH_SIZE, TODDLE_PAGE_SIZE, LOG_LEVEL, cron). Mudar o tamanho do lote
 * não torna o dado do job errado, e forçar reprocesso nesses casos seria atrito
 * sem ganho.
 */
export function configVersion(): string {
  const relevante = {
    tenant: env.TENANT_SLUG,
    campi: env.RM_CODFILIAL,
    orgDestino: env.TODDLE_ORG_ID,
    sentencaAlunos: env.RM_SENTENCA_STUDENTS ?? '',
    coligada: env.RM_CODCOLIGADA,
    perlet: env.RM_CODPERLET ?? '',
    prefixoSourceId: env.SOURCE_ID_PREFIX,
    statusAtivos: env.RM_ACTIVE_TERM_STATUSES,
  };

  // Chaves ordenadas: a impressão não pode depender da ordem de declaração.
  const canonico = JSON.stringify(relevante, Object.keys(relevante).sort());
  return createHash('sha256').update(canonico).digest('hex').slice(0, 12);
}

/** Detalhamento legível — para log e para explicar uma recusa. */
export function configVersionDetalhe(): Record<string, string> {
  return {
    version: configVersion(),
    tenant: env.TENANT_SLUG,
    campi: env.RM_CODFILIAL,
    orgDestino: env.TODDLE_ORG_ID,
    sentencaAlunos: env.RM_SENTENCA_STUDENTS ?? '(vazia)',
    perlet: env.RM_CODPERLET ?? '(vazio)',
    prefixoSourceId: env.SOURCE_ID_PREFIX,
  };
}
