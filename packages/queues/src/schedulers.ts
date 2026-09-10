import { logger } from '@rm-toddle/config';
import { getQueue } from './queues';
import { FLUXOS_EM_ORDEM, acharFluxo, type Fluxo } from './fluxos';

/**
 * A ÚNICA porta de escrita no Job Scheduler do BullMQ.
 *
 * ─── O QUE MUDOU, E POR QUE ─────────────────────────────────────────────────
 *
 * Antes este arquivo era a definição da agenda: ele lia `STUDENTS_SYNC_CRON`,
 * derivava o cron do professor e decidia, por `NOTA_SYNC_ATIVO`, se registrava
 * ou removia o poll da nota. Fazia sentido enquanto a agenda era o ambiente.
 *
 * Agora a agenda mora em `flow_schedule` (migration 016) e quem decide é o
 * reconciliador, em apps/worker/src/agenda/reconciliar.ts. Este módulo perdeu a
 * decisão e ficou só com a MECÂNICA: aplicar, remover, observar. Ele não lê
 * ambiente nem banco — de propósito. Um módulo que só executa não pode discordar
 * de quem decide.
 *
 * ─── ESCRITOR ÚNICO ─────────────────────────────────────────────────────────
 *
 * `upsertJobScheduler` e `removeJobScheduler` só são chamados aqui, e este módulo
 * só é chamado pelo reconciliador. A API NÃO escreve no Redis, mesmo tendo acesso
 * — ela grava a intenção no Postgres e avisa. Três razões, e a primeira é
 * histórica: dois lugares registrando o mesmo scheduler foi o risco que o
 * comentário original deste arquivo existia para conter. A segunda é durabilidade
 * (intenção no Redis evapora num restart sem persistência; no Postgres, não). A
 * terceira é raio de dano: a API é o processo exposto.
 */

/** Fuso de todo agendamento. O mesmo de packages/config/src/cron.ts. */
const TZ = 'America/Sao_Paulo';

/** Aplica (upsert) a agenda de um fluxo. Idempotente pelo id do scheduler. */
export async function aplicarAgenda(fluxo: Fluxo, cron: string, tz: string = TZ): Promise<void> {
  const queue = getQueue(fluxo.fila);
  await queue.upsertJobScheduler(
    fluxo.key,
    { pattern: cron, tz },
    { name: fluxo.job, data: { trigger: 'cron' } },
  );
}

/**
 * Remove o scheduler de um fluxo. `true` quando havia algo para remover.
 *
 * Desligar um fluxo TEM de remover, não apenas deixar de registrar: o registro
 * vive no Redis, não no código. "Parar de registrar" não para nada — o registro
 * anterior segue lá e o cron segue disparando, e a escola veria job rodando
 * depois de pedir para desligar. O interruptor é de duas vias.
 */
export async function removerAgenda(fluxo: Fluxo): Promise<boolean> {
  const queue = getQueue(fluxo.fila);
  return queue.removeJobScheduler(fluxo.key).catch((err) => {
    logger.warn({ err: (err as Error).message, flowKey: fluxo.key }, 'Falha ao remover scheduler');
    return false;
  });
}

/** Remove um scheduler por id cru — para varrer registro órfão. Ver `observar`. */
export async function removerSchedulerPorId(fila: string, id: string): Promise<boolean> {
  return getQueue(fila)
    .removeJobScheduler(id)
    .catch((err) => {
      logger.warn({ err: (err as Error).message, id, fila }, 'Falha ao remover scheduler órfão');
      return false;
    });
}

export interface SchedulerObservado {
  /** Id do scheduler no Redis. Para os nossos, é o `flow_key`. */
  id: string;
  fila: string;
  cron: string | null;
  tz: string | null;
  /** Próximo disparo em ISO, como o BullMQ calculou. `null` se ele não sabe. */
  proximoDisparoEm: string | null;
  iteracoes: number | null;
  /**
   * `true` quando o id não corresponde a nenhum fluxo do catálogo.
   *
   * Não é curiosidade: um scheduler órfão continua disparando para sempre e não
   * aparece em nenhuma configuração — é invisível por natureza. Esta troca de
   * agenda produz órfãos de propósito UMA vez, porque os ids antigos eram
   * `students-sync-nightly`, `staff-sync-nightly` e `term-grades-poll`, e os
   * novos são as chaves de fluxo. A reconciliação varre os dois casos.
   */
  desconhecido: boolean;
}

/** O que o Redis diz que está agendado nas filas dos fluxos. Só leitura. */
export async function observarSchedulers(): Promise<SchedulerObservado[]> {
  // Uma fila pode servir mais de um fluxo no futuro; hoje é 1:1. Deduplicar
  // evita listar a mesma fila duas vezes se isso mudar.
  const filas = [...new Set(FLUXOS_EM_ORDEM.map((f) => f.fila))];

  const porFila = await Promise.all(
    filas.map(async (fila) => {
      try {
        // O BullMQ pagina; 100 é folgado para um sistema com 3 fluxos, e o corte
        // explícito evita depender do default da biblioteca.
        const lista = await getQueue(fila).getJobSchedulers(0, 99);
        return lista.map<SchedulerObservado>((s) => ({
          id: s.key,
          fila,
          cron: s.pattern ?? null,
          tz: s.tz ?? null,
          proximoDisparoEm: s.next ? new Date(s.next).toISOString() : null,
          iteracoes: s.iterationCount ?? null,
          desconhecido: !acharFluxo(s.key),
        }));
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, fila },
          'Não foi possível ler os schedulers desta fila — a tela mostrará "não observado"',
        );
        return [];
      }
    }),
  );
  return porFila.flat();
}
