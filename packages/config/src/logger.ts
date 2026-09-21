import pino from 'pino';
import { env } from './env';

/**
 * ─── ERRO DE AXIOS NÃO VAI INTEIRO PARA O LOG ───────────────────────────────
 *
 * Medido em 21/09/2026 no `docker logs` da api: um 401 do RM imprimiu o objeto
 * de erro do axios INTEIRO — e dentro dele `config.auth.password` em texto
 * claro, mais o `Authorization: Basic ...` dentro de `request._header`. A senha
 * do usuário de integração do RM ficou legível para quem tivesse acesso ao
 * container, numa linha de ~50KB que ninguém leria inteira.
 *
 * Não é um descuido de quem logou: o serializador padrão do pino
 * (`stdSerializers.err`) copia TODA propriedade própria e enumerável do erro, e
 * `config`, `request` e `response` são exatamente isso num `AxiosError`. Ou
 * seja, qualquer `logger.error({ err })` neste projeto vazaria a credencial —
 * inclusive os que ainda não foram escritos.
 *
 * `redact` por caminho tiraria a senha e deixaria o header Basic, que é a mesma
 * credencial em base64. O que fecha a classe toda é NÃO serializar `config`,
 * `request` e `response`. Fica o que serve para diagnosticar: mensagem, código,
 * método, URL e status.
 */
export function serializarErro(erro: unknown): unknown {
  const e = erro as {
    isAxiosError?: boolean;
    message?: string;
    code?: string;
    status?: number;
    response?: { status?: number };
    config?: { method?: string; baseURL?: string; url?: string };
  };

  if (e?.isAxiosError !== true) return pino.stdSerializers.err(erro as Error);

  return {
    type: 'AxiosError',
    message: e.message,
    code: e.code,
    status: e.response?.status ?? e.status ?? null,
    metodo: e.config?.method?.toUpperCase(),
    // baseURL + url, sem query: é o suficiente para saber QUEM recusou.
    url: `${e.config?.baseURL ?? ''}${e.config?.url ?? ''}` || null,
  };
}

export const logger = pino({
  level: env.LOG_LEVEL,
  serializers: { err: serializarErro },
  transport:
    env.NODE_ENV !== 'production'
      ? {
          target: 'pino-pretty',
          options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        }
      : undefined,
});
