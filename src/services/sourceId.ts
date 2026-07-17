import { env } from '../config/env';

/**
 * sourceId no Toddle = SOURCE_ID_PREFIX + código de negócio do RM (RA/CHAPA).
 * Ex.: prefixo "1-" (coligada) + RA "12345" -> "1-12345".
 *
 * REGRA DE OURO: escolha o formato UMA vez e nunca mude — o sourceId é o elo
 * de idempotência entre os dois sistemas.
 */
export function buildSourceId(rmCode: string): string {
  return `${env.SOURCE_ID_PREFIX}${rmCode}`;
}

/** Operação inversa: extrai o código do RM a partir do sourceId do Toddle. */
export function rmCodeFromSourceId(sourceId: string): string {
  return env.SOURCE_ID_PREFIX && sourceId.startsWith(env.SOURCE_ID_PREFIX)
    ? sourceId.slice(env.SOURCE_ID_PREFIX.length)
    : sourceId;
}
