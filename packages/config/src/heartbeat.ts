import { env } from './env';
import { logger } from './logger';

/**
 * Ping para monitor externo de "ausência de sucesso" (dead man's switch).
 *
 * ─── POR QUE ISTO EXISTE, E POR QUE É EXTERNO ───────────────────────────────
 *
 * Entre 12 e 20/08/2026 a integração ficou 8 dias sem escrever nada e ninguém
 * soube. A causa encadeada (banco do RM caiu -> senha expirou -> Sentenças
 * desapareceram) é irrelevante para o desenho: o que importa é que **nenhum
 * alerta construído dentro deste processo teria disparado**, porque o processo
 * era o que estava parado. Falha silenciosa não se resolve pedindo ao sistema
 * que avise da própria morte.
 *
 * A inversão resolve: o job avisa que está VIVO, e um terceiro reclama quando o
 * aviso não chega. Isso cobre container morto, Redis fora, cron não registrado,
 * credencial expirada e deploy quebrado — tudo com a mesma linha de código.
 *
 * ─── PROTOCOLO ──────────────────────────────────────────────────────────────
 *
 * Convenção do Healthchecks.io, que o Uptime Kuma e similares também aceitam:
 *
 *   GET <url>         sucesso
 *   GET <url>/fail    falha explícita (alerta AGORA, não espera o limiar)
 *
 * O `/fail` importa: sem ele, um job que falha às 03:00 só viraria alerta quando
 * o limiar de silêncio estourasse, horas depois. Com ele, falha conhecida é
 * imediata e silêncio continua coberto pelo limiar.
 */
export type ResultadoRun = 'sucesso' | 'falha';

/**
 * Dispara o ping. NUNCA lança e NUNCA rejeita.
 *
 * Isto é regra, não descuido: se o monitor estiver fora do ar, o sync tem de
 * continuar. Monitor que derruba o que ele monitora é pior que monitor nenhum —
 * e a falha do ping fica no log com nível warn, então não desaparece.
 */
export async function pingHeartbeat(
  url: string | undefined,
  resultado: ResultadoRun,
  contexto: Record<string, unknown> = {},
): Promise<void> {
  if (!url) return; // não configurado = desligado, de propósito

  const alvo = resultado === 'falha' ? `${url.replace(/\/+$/, '')}/fail` : url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.HEARTBEAT_TIMEOUT_MS);

  try {
    const res = await fetch(alvo, { method: 'GET', signal: controller.signal });
    if (!res.ok) {
      logger.warn(
        { status: res.status, resultado, ...contexto },
        'Heartbeat recusado pelo monitor — o job seguiu normalmente',
      );
      return;
    }
    logger.debug({ resultado, ...contexto }, 'Heartbeat enviado');
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, resultado, ...contexto },
      'Heartbeat não pôde ser enviado — o job seguiu normalmente. ' +
        'ATENÇÃO: o monitor externo vai alertar por silêncio, e o alerta será falso positivo',
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Atalhos, para o processador não precisar saber de qual variável vem a URL. */
export const heartbeat = {
  alunos: (resultado: ResultadoRun, contexto?: Record<string, unknown>) =>
    pingHeartbeat(env.HEARTBEAT_URL_ALUNOS, resultado, { job: 'alunos', ...contexto }),
  professores: (resultado: ResultadoRun, contexto?: Record<string, unknown>) =>
    pingHeartbeat(env.HEARTBEAT_URL_PROFESSORES, resultado, { job: 'professores', ...contexto }),
  notas: (resultado: ResultadoRun, contexto?: Record<string, unknown>) =>
    pingHeartbeat(env.HEARTBEAT_URL_NOTAS, resultado, { job: 'notas', ...contexto }),
  // A segunda escrita em registro acadêmico tem o próprio canal: somar as duas
  // num monitor só faria a falha de uma ser confundida com a da outra, e são
  // consertos diferentes.
  frequencia: (resultado: ResultadoRun, contexto?: Record<string, unknown>) =>
    pingHeartbeat(env.HEARTBEAT_URL_FREQUENCIA, resultado, { job: 'frequencia', ...contexto }),
};
