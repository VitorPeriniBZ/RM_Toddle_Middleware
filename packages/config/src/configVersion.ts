import { createHash } from 'node:crypto';
import { tenantConfig, type TenantConfig } from './tenantConfig';

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
 * CORREÇÃO DE 21/08/2026: a impressão era derivada do AMBIENTE, então era por
 * DEPLOY. Num processo que atenda mais de uma escola, dois tenants com escopos
 * diferentes gerariam a MESMA impressão — e a proteção passaria a mentir,
 * aceitando lote de um escopo como se fosse de outro. Agora deriva do
 * `TenantConfig` resolvido, então é por escola por construção.
 *
 * O QUE NÃO ENTRA: nada que seja só de desempenho ou operação
 * (SYNC_BATCH_SIZE, TODDLE_PAGE_SIZE, LOG_LEVEL, cron). Mudar o tamanho do lote
 * não torna o dado do job errado, e forçar reprocesso nesses casos seria atrito
 * sem ganho.
 */
export function configVersion(cfg: TenantConfig = tenantConfig): string {
  const relevante = {
    tenant: cfg.slug,
    campi: cfg.rm.escopo.filiais,
    orgDestino: cfg.toddle.organizationId,
    sentencaAlunos: cfg.rm.sentencas.alunos ?? '',
    coligada: cfg.rm.escopo.coligada,
    perlet: cfg.rm.escopo.periodoLetivo ?? '',
    prefixoSourceId: cfg.sourceIdPrefix,
    statusAtivos: cfg.rm.escopo.statusAtivos,
  };

  // Chaves ordenadas: a impressão não pode depender da ordem de declaração.
  const canonico = JSON.stringify(relevante, Object.keys(relevante).sort());
  return createHash('sha256').update(canonico).digest('hex').slice(0, 12);
}

/** Detalhamento legível — para log e para explicar uma recusa. */
export function configVersionDetalhe(cfg: TenantConfig = tenantConfig): Record<string, string> {
  return {
    version: configVersion(cfg),
    tenant: cfg.slug,
    campi: cfg.rm.escopo.filiais,
    orgDestino: cfg.toddle.organizationId,
    sentencaAlunos: cfg.rm.sentencas.alunos ?? '(vazia)',
    perlet: cfg.rm.escopo.periodoLetivo ?? '(vazio)',
    prefixoSourceId: cfg.sourceIdPrefix,
  };
}
