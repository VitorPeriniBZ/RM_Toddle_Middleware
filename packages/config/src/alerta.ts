import { env } from './env';
import { logger } from './logger';

/**
 * Alerta ATIVO por webhook — o canal que faltava.
 *
 * ─── POR QUE ISTO EXISTE, TENDO HEARTBEAT ───────────────────────────────────
 *
 * O heartbeat (heartbeat.ts) é a inversão certa para UM modo de falha: o
 * processo morto. Um terceiro reclama quando o ping não chega, e isso cobre
 * container caído, Redis fora, credencial expirada e deploy quebrado.
 *
 * Ele NÃO cobre o modo de falha que deixou 62 jobs parados na DLQ por sete dias:
 * o worker seguia vivo e pingando, os jobs morriam um a um, e o silêncio nunca
 * aconteceu — logo nenhum alerta por silêncio disparou. Falha com o processo
 * saudável precisa do processo falando.
 *
 * Os dois juntos cobrem "morreu" e "está vivo e errando". Nenhum dos dois
 * sozinho cobre os dois.
 *
 * ─── MESMA DISCIPLINA DO HEARTBEAT ──────────────────────────────────────────
 *
 * NUNCA lança e NUNCA rejeita. Canal de alerta que derruba o que ele observa é
 * pior que canal nenhum. Falha de envio fica no log em nível warn.
 *
 * ─── FORMATO DO CORPO ───────────────────────────────────────────────────────
 *
 * `{ text, content }` — as duas chaves, de propósito. Slack e ntfy leem `text`,
 * Discord lê `content`. Mandar as duas faz o mesmo webhook servir aos três sem
 * uma variável de "qual provedor é este", e a chave extra é ignorada por quem
 * não a conhece.
 */

export interface Alerta {
  /** Uma linha, começando pelo que quebrou. Vai no título da notificação. */
  assunto: string;
  /** Contexto estruturado: fluxo, chave do run, motivo. Vira texto legível. */
  contexto?: Record<string, unknown>;
}

/**
 * Guarda contra tempestade de alerta.
 *
 * Um extract que falha faz 50 lotes falharem atrás dele. Sem esta guarda, o
 * canal recebe 51 mensagens do mesmo defeito, e canal que grita 51 vezes é canal
 * que alguém silencia — perdendo também o alerta seguinte, que talvez importe.
 *
 * A janela é por ASSUNTO: dois defeitos diferentes na mesma janela passam os
 * dois. É supressão de repetição, não de volume.
 */
const JANELA_REPETICAO_MS = 10 * 60 * 1_000;
const ultimoEnvio = new Map<string, number>();

/**
 * Envia o alerta. Nunca lança. Devolve `false` quando não enviou.
 *
 * ─── SEM CANAL, O ALERTA É DEGRADADO — NUNCA PERDIDO ────────────────────────
 *
 * Esta função abria com `if (!env.ALERTA_WEBHOOK_URL) return false;`, comentado
 * como "não configurado = desligado, de propósito". A intenção era não obrigar
 * quem roda local a montar um webhook. O efeito foi outro: como NENHUMA URL
 * estava configurada em lugar nenhum, o vigia rodava, encontrava o problema,
 * chamava esta função, e ela devolvia `false` calada. Toda vez.
 *
 * Foi assim que 62 jobs ficaram sete dias parados na DLQ.
 *
 * Continua legítimo rodar sem webhook. O que deixou de ser legítimo é o alerta
 * EVAPORAR: sem canal, o conteúdo inteiro vai para o log em nível `error`, que
 * é o nível que sobrevive a um filtro de produção. A informação perde alcance,
 * não existência. A supressão por repetição vale também aqui — um extract que
 * falha faz 50 lotes falharem atrás dele, e 51 linhas de `error` idênticas é a
 * mesma tempestade que a janela existe para conter.
 */
export async function alertar(alerta: Alerta): Promise<boolean> {
  const agora = Date.now();
  const anterior = ultimoEnvio.get(alerta.assunto);
  if (anterior !== undefined && agora - anterior < JANELA_REPETICAO_MS) {
    logger.debug(
      { assunto: alerta.assunto, haMs: agora - anterior },
      'Alerta suprimido: mesmo assunto dentro da janela de repetição',
    );
    return false;
  }
  ultimoEnvio.set(alerta.assunto, agora);

  const linhas = Object.entries(alerta.contexto ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `• ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  const texto = [`[${env.TENANT_SLUG}] ${alerta.assunto}`, ...linhas].join('\n');

  if (!env.ALERTA_WEBHOOK_URL) {
    logger.error(
      { assunto: alerta.assunto, contexto: alerta.contexto, canal: 'DESLIGADO' },
      `ALERTA SEM CANAL — ninguém foi avisado. Defina ALERTA_WEBHOOK_URL (Slack, Discord ou ` +
        `ntfy) para que este aviso chegue a alguém. Conteúdo do alerta:\n${texto}`,
    );
    return false;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.ALERTA_WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(env.ALERTA_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: texto, content: texto }),
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn(
        { status: res.status, assunto: alerta.assunto },
        'Canal de alerta recusou a mensagem — o worker seguiu normalmente',
      );
      return false;
    }
    logger.debug({ assunto: alerta.assunto }, 'Alerta enviado');
    return true;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, assunto: alerta.assunto },
      'Alerta não pôde ser enviado — o worker seguiu normalmente. ' +
        'ATENÇÃO: este defeito ficou SEM aviso; só o log registra',
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Zera a supressão. Existe para o teste não depender de tempo de parede. */
export function limparJanelaDeAlerta(): void {
  ultimoEnvio.clear();
}
