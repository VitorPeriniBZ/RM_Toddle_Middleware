import IORedis from 'ioredis';
import { env, logger } from '@rm-toddle/config';

/**
 * Conexão Redis compartilhada por filas e workers.
 * maxRetriesPerRequest: null é REQUISITO do BullMQ (comandos bloqueantes).
 */
export const redisConnection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

/**
 * Canal de aviso "a agenda mudou".
 *
 * ─── POR QUE PUB/SUB EXISTE AQUI, E POR QUE ELE NÃO É A GARANTIA ────────────
 *
 * A API grava a intenção no Postgres e publica neste canal; o worker reconcilia
 * ao receber. É o que faz a tela responder em segundos em vez de esperar o poll.
 *
 * Mas pub/sub é entrega no MÁXIMO uma vez: se o worker estiver reiniciando, ou o
 * Redis reiniciar entre a publicação e a entrega, a mensagem simplesmente não
 * chega e ninguém fica sabendo. Os dois cenários são exatamente os que já
 * custaram caro neste projeto.
 *
 * Então a garantia é o POLL da reconciliação, que converge sozinho; este canal é
 * conveniência POR CIMA dele, nunca no lugar dele. Se algum dia alguém remover o
 * poll "porque o pub/sub já avisa", a falha volta — e volta silenciosa.
 */
export const CANAL_AGENDA = 'agenda:mudou';

/** Avisa que a agenda mudou. Nunca lança: o poll cobre a perda do aviso. */
export async function avisarAgendaMudou(flowKey: string): Promise<void> {
  try {
    await redisConnection.publish(CANAL_AGENDA, flowKey);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, flowKey },
      'Não foi possível avisar a mudança de agenda — o poll da reconciliação vai pegar',
    );
  }
}

/**
 * Assina o canal. Devolve a conexão para quem precisa encerrá-la.
 *
 * Conexão DUPLICADA, e isso é exigência do Redis, não preferência: uma conexão em
 * modo subscriber não aceita mais nenhum outro comando. Assinar na conexão
 * compartilhada quebraria todas as filas do processo.
 */
export function assinarAgenda(aoMudar: (flowKey: string) => void): IORedis {
  const assinante = redisConnection.duplicate();
  assinante.on('error', (err) => logger.warn({ err: err.message }, 'Erro na conexão do assinante da agenda'));
  void assinante.subscribe(CANAL_AGENDA).catch((err) => {
    logger.error(
      { err: (err as Error).message, canal: CANAL_AGENDA },
      'Falha ao assinar o canal da agenda — mudança pela tela só será aplicada no próximo poll',
    );
  });
  assinante.on('message', (canal, mensagem) => {
    if (canal === CANAL_AGENDA) aoMudar(mensagem);
  });
  return assinante;
}
