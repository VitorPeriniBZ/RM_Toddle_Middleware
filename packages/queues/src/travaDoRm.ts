import { tenantConfig } from '@rm-toddle/config';
import { redisConnection } from './connection';

/**
 * A TRAVA DE CREDENCIAL DO RM — compartilhada por todos os detectores.
 *
 * ─── O QUE ELA IMPEDE ───────────────────────────────────────────────────────
 *
 * O RM bloqueia o usuário da integração depois de ~6 recusas seguidas (medido
 * em 29/09/2026). Todo fluxo lê o RM, então um detector do TODDLE que
 * disparasse o fluxo de nota a cada nota publicada, com a senha expirada,
 * produziria uma recusa por minuto — e bloquearia o usuário em minutos,
 * derrubando junto a agenda inteira. O cron já tinha essa fraqueza, mas no ritmo
 * dele (horas); o detector a tornaria rápida.
 *
 * Qualquer recusa de credencial vista por um job ou pela sonda do RM grava a
 * trava; enquanto ela vale, NENHUM detector sonda nem dispara.
 *
 * ─── A PAUSA CRESCE ─────────────────────────────────────────────────────────
 *
 * Senha expirada (FE005) não se resolve esperando. Uma pausa fixa de 30 min
 * seria uma recusa a cada 30 min — seis em três horas, o bloqueio de novo. Por
 * isso cada recusa seguida quadruplica a pausa (30 min, 2 h, 8 h, teto de 24 h),
 * e quem corrige a senha libera na hora pelo botão "Retomar" da tela.
 */

const prefixo = (): string => `continuo:rm-credencial:${tenantConfig.slug}`;
const TETO_MS = 24 * 3_600_000;

export interface TravaDoRm {
  restanteMs: number;
  ate: string;
  motivo: string;
  /** Recusas seguidas que a produziram. Zera quando alguém retoma. */
  recusas: number;
}

/** Grava a recusa e devolve a pausa aplicada. A pausa cresce a cada recusa seguida. */
export async function registrarRecusaDeCredencialDoRm(baseMs: number, motivo: string): Promise<TravaDoRm> {
  const recusas = await redisConnection.incr(`${prefixo()}:recusas`);
  // O contador vive mais que qualquer pausa: é ele que lembra que a recusa
  // anterior também foi de credencial.
  await redisConnection.pexpire(`${prefixo()}:recusas`, 2 * TETO_MS);
  const pausaMs = Math.min(baseMs * 4 ** Math.max(recusas - 1, 0), TETO_MS);
  const ate = new Date(Date.now() + pausaMs).toISOString();
  await redisConnection.set(`${prefixo()}:trava`, JSON.stringify({ ate, motivo: motivo.slice(0, 300) }), 'PX', pausaMs);
  return { restanteMs: pausaMs, ate, motivo, recusas };
}

/** A trava em vigor, ou `null`. Nunca lança: sem Redis, quem decide é o próprio job. */
export async function travaDoRm(): Promise<TravaDoRm | null> {
  try {
    const [valor, pttl, recusas] = await Promise.all([
      redisConnection.get(`${prefixo()}:trava`),
      redisConnection.pttl(`${prefixo()}:trava`),
      redisConnection.get(`${prefixo()}:recusas`),
    ]);
    if (!valor || pttl <= 0) return null;
    const v = JSON.parse(valor) as { ate: string; motivo: string };
    return { restanteMs: pttl, ate: v.ate, motivo: v.motivo, recusas: Number(recusas ?? 1) };
  } catch {
    return null;
  }
}

/**
 * O RM aceitou a credencial: tira a trava e zera a contagem. Chamado quando uma
 * consulta ao RM dá certo — a varredura da agenda, a sonda de cadastros. Não
 * quando a trava vence: vencer não prova nada sobre a senha, e por isso a
 * contagem sobrevive ao vencimento.
 *
 * Cobre a recusa que passa sozinha (a janela de cópia de base): o primeiro job
 * que conseguir ler o RM devolve os detectores, sem esperar as 2 ou 8 horas.
 */
export async function credencialDoRmAceita(): Promise<void> {
  await redisConnection.del(`${prefixo()}:trava`, `${prefixo()}:recusas`).catch(() => undefined);
}

/** "Retomar" da tela: alguém corrigiu a senha e quer os detectores de volta já. */
export async function liberarTravaDoRm(): Promise<void> {
  await redisConnection.del(`${prefixo()}:trava`, `${prefixo()}:recusas`);
}
