import { tenantConfig } from '@rm-toddle/config';

/**
 * A config da escola que este processo atende.
 *
 * `tenantConfig` em vez de `env`: quando a origem virar a tabela
 * `integration_connection`, nada aqui muda. Função NOVA deve receber
 * `cfg: TenantConfig` como parâmetro em vez de usar esta constante — ver a nota
 * em packages/config/src/tenantConfig.ts.
 */
const cfg = tenantConfig;

/**
 * sourceId no Toddle = SOURCE_ID_PREFIX + código de negócio do RM (RA/CHAPA).
 * Ex.: prefixo "1-" (coligada) + RA "12345" -> "1-12345".
 *
 * REGRA DE OURO: escolha o formato UMA vez e nunca mude — o sourceId é o elo
 * de idempotência entre os dois sistemas.
 */
export function buildSourceId(rmCode: string): string {
  return `${cfg.sourceIdPrefix}${rmCode}`;
}

/** Operação inversa: extrai o código do RM a partir do sourceId do Toddle. */
export function rmCodeFromSourceId(sourceId: string): string {
  return cfg.sourceIdPrefix && sourceId.startsWith(cfg.sourceIdPrefix)
    ? sourceId.slice(cfg.sourceIdPrefix.length)
    : sourceId;
}
