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
 * Estrangulamento do aviso de "este fluxo não tem heartbeat".
 *
 * Por FLUXO, e não global: quatro fluxos sem monitor são quatro problemas
 * distintos, e colapsá-los num aviso só esconderia três. Uma hora é a janela
 * porque o fluxo mais frequente roda a cada 15 minutos — o aviso precisa
 * aparecer todo dia sem virar ele mesmo uma fonte de ruído.
 */
const JANELA_DO_AVISO_MS = 60 * 60 * 1_000;
const ultimoAviso = new Map<string, number>();

function avisarUmaVezPorHora(contexto: Record<string, unknown>): void {
  const fluxo = typeof contexto.job === 'string' ? contexto.job : 'desconhecido';
  const agora = Date.now();
  const anterior = ultimoAviso.get(fluxo);
  if (anterior !== undefined && agora - anterior < JANELA_DO_AVISO_MS) return;
  ultimoAviso.set(fluxo, agora);

  logger.warn(
    { fluxo, heartbeat: 'DESLIGADO' },
    `O fluxo "${fluxo}" rodou sem heartbeat configurado: se ele parar de rodar, NINGUÉM será ` +
      `avisado. Defina HEARTBEAT_URL_${fluxo.toUpperCase()} apontando para um monitor externo ` +
      `(Healthchecks.io, Uptime Kuma). Ver docs/TODO.md.`,
  );
}

/** Zera o estrangulamento do aviso. Existe para o teste não depender do relógio. */
export function limparAvisosDeHeartbeat(): void {
  ultimoAviso.clear();
}

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
  /*
   * ─── SEM URL, O SILÊNCIO APARECE NO LOG ──────────────────────────────────
   *
   * Esta linha era `if (!url) return;`, comentada como "não configurado =
   * desligado, de propósito". O problema não era a intenção: era que NENHUMA
   * das quatro URLs estava configurada, e portanto nenhum fluxo deste sistema
   * tinha quem reclamasse do silêncio dele — inclusive o de FREQUÊNCIA, que
   * escreve falta no registro acadêmico.
   *
   * O aviso é estrangulado por FLUXO e por hora, não emitido a cada ping: o
   * fluxo de notas roda a cada 15 minutos, e um warn por run transformaria o
   * log numa segunda fonte de ruído — que é exatamente o problema que os 6,3 GB
   * de `ECONNREFUSED` representam.
   */
  if (!url) {
    avisarUmaVezPorHora(contexto);
    return;
  }

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
