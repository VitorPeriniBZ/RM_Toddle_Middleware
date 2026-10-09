import { getQueue } from './queues';
import type { Fluxo } from './fluxos';
import { ESTADOS_NAO_TERMINAIS, type JobEmVoo } from './execucaoEmVoo';
import { tenantConfig } from '@rm-toddle/config';
import { redisConnection } from './connection';
import {
  decidirDisparo, planejarInicio, PREFIXO_DO_DISPARO_CONTINUO, RITMO_POR_FLUXO, type JobNaFila,
} from './detectores';

/**
 * A mecânica de fila do "tempo quase real". A DECISÃO mora em `detectores.ts`,
 * que é puro e testado; este arquivo só fala com o Redis.
 */

export type DesfechoDoDisparo = 'enfileirado' | 'ja-na-fila';

/** Onde fica o início planejado da última passada disparada por detector. */
const chaveDoUltimoInicio = (flowKey: string): string => `continuo:ultimo-inicio:${tenantConfig.slug}:${flowKey}`;

/**
 * Pede uma passada do fluxo porque o detector viu mudança.
 *
 * Não confere se o fluxo está ligado nem se pode ser ativado: isso é decisão de
 * quem chama (o worker, que lê a agenda). Este módulo só faz a mecânica da fila
 * — e o RITMO: a passada entra com `delay` quando o espaçamento ou o atraso do
 * fluxo pedem (`RITMO_POR_FLUXO`). Um job com `delay` conta como esperando para
 * `decidirDisparo`, então as mudanças que chegarem até lá são absorvidas por ele.
 */
export async function dispararPorMudanca(
  fluxo: Fluxo,
  motivo: Record<string, unknown>,
): Promise<{ desfecho: DesfechoDoDisparo; jobId?: string; inicioEm?: string }> {
  const fila = getQueue(fluxo.fila);
  const naFila = await fila.getJobs([...ESTADOS_NAO_TERMINAIS]);
  const jobs: JobNaFila[] = await Promise.all(
    naFila.map(async (j) => ({
      nome: j.name,
      estado: (await j.getState()) as JobEmVoo['estado'],
      repeatJobKey: (j as { repeatJobKey?: string | null }).repeatJobKey ?? null,
    })),
  );
  if (decidirDisparo(jobs, fluxo.job) === 'ja-na-fila') return { desfecho: 'ja-na-fila' };

  const agora = Date.now();
  const anterior = Number(await redisConnection.get(chaveDoUltimoInicio(fluxo.key)));
  const inicio = planejarInicio(agora, Number.isFinite(anterior) && anterior > 0 ? anterior : null, RITMO_POR_FLUXO[fluxo.key]);
  const jobId = `${PREFIXO_DO_DISPARO_CONTINUO}${fluxo.key}:${agora}`;
  await fila.add(fluxo.job, { trigger: 'continuo', motivo }, { jobId, delay: Math.max(0, inicio - agora) });
  // Expira sozinho: passado o espaçamento mais longo, a lembrança não serve
  // para nada, e chave eterna no Redis é lixo que ninguém limpa.
  await redisConnection.set(chaveDoUltimoInicio(fluxo.key), String(inicio), 'PX', inicio - agora + 2 * 3_600_000);
  return { desfecho: 'enfileirado', jobId, inicioEm: new Date(inicio).toISOString() };
}
