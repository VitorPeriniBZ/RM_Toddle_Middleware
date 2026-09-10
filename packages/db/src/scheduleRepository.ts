import { logger, tenantConfig } from '@rm-toddle/config';
import { pgPool } from './pool';
import type { Executor } from './executor';

/** Config da escola atendida por este processo. Ver packages/config/src/tenantConfig.ts. */
const cfg = tenantConfig;

/**
 * A AGENDA de cada fluxo, na tabela `flow_schedule` (migration 016).
 *
 * ─── ESTE MÓDULO É A FONTE DE VERDADE DO "QUANDO" ───────────────────────────
 *
 * Antes da tela, o horário vinha de variável de ambiente e mudá-lo exigia
 * redeploy manual. Agora vem daqui. O ambiente virou semente: `semear()` só
 * insere o que ainda não existe, e depois disso nada mais lê o env para decidir
 * horário.
 *
 * ─── INTENÇÃO E APLICAÇÃO SÃO COISAS DIFERENTES ─────────────────────────────
 *
 * `cron`/`ativo`/`revisao` são a INTENÇÃO de quem usou a tela. `revisao_aplicada`
 * e `aplicada_em` são o que o worker conseguiu efetivar no Redis. Elas divergem
 * de verdade — Redis reiniciado sem persistência, worker fora do ar, erro na
 * aplicação — e a tela mostra as duas. Uma tela que exibisse só a intenção seria
 * mais uma superfície capaz de mentir, que é o oposto do que se quer dela.
 */

/** Uma linha da agenda, como a tela e o reconciliador a leem. */
export interface AgendaDoFluxo {
  flowKey: string;
  cron: string;
  timezone: string;
  ativo: boolean;
  revisao: number;
  /** Revisão que o worker conseguiu aplicar no Redis. `null` = nunca aplicada. */
  revisaoAplicada: number | null;
  aplicadaEm: string | null;
  /** Último erro de aplicação. `null` quando a última tentativa deu certo. */
  erroAoAplicar: string | null;
  atualizadoPor: string | null;
  atualizadoEm: string;
}

interface LinhaAgenda {
  flow_key: string;
  cron: string;
  timezone: string;
  ativo: boolean;
  revisao: string;
  revisao_aplicada: string | null;
  aplicada_em: Date | null;
  erro_ao_aplicar: string | null;
  atualizado_por: string | null;
  updated_at: Date;
}

function paraAgenda(r: LinhaAgenda): AgendaDoFluxo {
  return {
    flowKey: r.flow_key,
    cron: r.cron,
    timezone: r.timezone,
    ativo: r.ativo,
    revisao: Number(r.revisao),
    revisaoAplicada: r.revisao_aplicada === null ? null : Number(r.revisao_aplicada),
    aplicadaEm: r.aplicada_em ? new Date(r.aplicada_em).toISOString() : null,
    erroAoAplicar: r.erro_ao_aplicar,
    atualizadoPor: r.atualizado_por,
    atualizadoEm: new Date(r.updated_at).toISOString(),
  };
}

const COLUNAS = `flow_key, cron, timezone, ativo, revisao, revisao_aplicada,
                 aplicada_em, erro_ao_aplicar, atualizado_por, updated_at`;

let tenantIdCache: string | null = null;
/** Mesma resolução dos outros repositórios: sem tenant, nada é lido nem gravado. */
export async function tenantIdDaAgenda(exec: Executor = pgPool): Promise<string> {
  if (tenantIdCache) return tenantIdCache;
  const { rows } = await exec.query<{ id: string }>(
    "SELECT id FROM tenant WHERE slug = $1 AND status = 'active'",
    [cfg.slug],
  );
  if (!rows[0]) {
    throw new Error(`TENANT_SLUG="${cfg.slug}" não existe (ou está suspenso) na tabela tenant.`);
  }
  tenantIdCache = rows[0].id;
  return tenantIdCache;
}

/** A agenda inteira deste tenant. São poucas linhas (uma por fluxo). */
export async function listarAgenda(exec: Executor = pgPool): Promise<AgendaDoFluxo[]> {
  const { rows } = await exec.query<LinhaAgenda>(
    `SELECT ${COLUNAS} FROM flow_schedule WHERE tenant_id = $1 ORDER BY flow_key`,
    [await tenantIdDaAgenda(exec)],
  );
  return rows.map(paraAgenda);
}

export async function lerAgenda(flowKey: string, exec: Executor = pgPool): Promise<AgendaDoFluxo | null> {
  const { rows } = await exec.query<LinhaAgenda>(
    `SELECT ${COLUNAS} FROM flow_schedule WHERE tenant_id = $1 AND flow_key = $2`,
    [await tenantIdDaAgenda(exec), flowKey],
  );
  return rows[0] ? paraAgenda(rows[0]) : null;
}

/**
 * Semeia a linha do fluxo a partir do ambiente — UMA VEZ.
 *
 * `ON CONFLICT DO NOTHING` é a precedência de uma via inteira, em uma cláusula:
 * a semente só vale quando não há linha. Depois disso, alterar a variável de
 * ambiente não muda nada, e é justamente esse o comportamento desejado — senão o
 * próximo deploy desfaria em silêncio o que a tela mudou.
 *
 * Devolve `true` quando de fato semeou.
 */
export async function semear(
  flowKey: string,
  cron: string,
  ativo: boolean,
  timezone: string,
  exec: Executor = pgPool,
): Promise<boolean> {
  const { rowCount } = await exec.query(
    `INSERT INTO flow_schedule (tenant_id, flow_key, cron, timezone, ativo)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, flow_key) DO NOTHING`,
    [await tenantIdDaAgenda(exec), flowKey, cron, timezone, ativo],
  );
  return (rowCount ?? 0) > 0;
}

export interface MudancaDeAgenda {
  flowKey: string;
  /** Ausente = mantém o cron atual. */
  cron?: string;
  /** Ausente = mantém o estado atual. */
  ativo?: boolean;
  /** `user_identity.id` de quem mudou. */
  atualizadoPor: string;
}

export interface AgendaAlterada {
  antes: AgendaDoFluxo;
  depois: AgendaDoFluxo;
}

/**
 * Aplica a mudança de intenção e SOBE A REVISÃO.
 *
 * Recebe um `Executor` em vez de usar o pool porque precisa rodar dentro da MESMA
 * transação do `audit_event`. Se a auditoria falhar, a mudança tem de falhar
 * junto — auditoria de melhor esforço é exatamente como `audit_event` continua
 * vazia com boa consciência.
 *
 * Devolve antes e depois: é o que o evento de auditoria grava, e o que a tela
 * mostra como diff.
 *
 * A revisão sobe SEMPRE que algo muda, e não muda quando nada mudou — assim o
 * poll do worker não regrava o mesmo scheduler a cada volta.
 */
export async function alterarAgenda(exec: Executor, m: MudancaDeAgenda): Promise<AgendaAlterada | null> {
  const tid = await tenantIdDaAgenda(exec);

  // FOR UPDATE: duas requisições simultâneas na mesma linha serializam, e a
  // segunda lê a revisão que a primeira gravou. Sem isso as duas partiriam da
  // mesma revisão e uma sobrescreveria a outra sem que a revisão subisse duas
  // vezes — o worker acharia que já aplicou o que nunca viu.
  const { rows: antesRows } = await exec.query<LinhaAgenda>(
    `SELECT ${COLUNAS} FROM flow_schedule WHERE tenant_id = $1 AND flow_key = $2 FOR UPDATE`,
    [tid, m.flowKey],
  );
  if (!antesRows[0]) return null;
  const antes = paraAgenda(antesRows[0]);

  const cron = m.cron ?? antes.cron;
  const ativo = m.ativo ?? antes.ativo;
  if (cron === antes.cron && ativo === antes.ativo) {
    return { antes, depois: antes }; // nada mudou: a revisão não sobe
  }

  const { rows } = await exec.query<LinhaAgenda>(
    `UPDATE flow_schedule
        SET cron = $3, ativo = $4, revisao = revisao + 1,
            atualizado_por = $5, erro_ao_aplicar = NULL, updated_at = now()
      WHERE tenant_id = $1 AND flow_key = $2
      RETURNING ${COLUNAS}`,
    [tid, m.flowKey, cron, ativo, m.atualizadoPor],
  );
  return { antes, depois: paraAgenda(rows[0]) };
}

/**
 * Registra o resultado da aplicação no Redis.
 *
 * NUNCA lança: é registro de estado observado, e falhar aqui não pode derrubar a
 * reconciliação — o próximo poll tenta de novo. Mesma regra do `job_run`.
 *
 * `erro = null` limpa o erro anterior, então a tela não mostra para sempre uma
 * falha que já foi resolvida.
 */
export async function marcarAplicada(
  flowKey: string,
  revisao: number,
  erro: string | null,
): Promise<void> {
  try {
    await pgPool.query(
      `UPDATE flow_schedule
          SET revisao_aplicada = $3, aplicada_em = now(), erro_ao_aplicar = $4
        WHERE tenant_id = $1 AND flow_key = $2`,
      [await tenantIdDaAgenda(), flowKey, revisao, erro?.slice(0, 500) ?? null],
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, flowKey, revisao },
      'Não foi possível registrar a aplicação da agenda — a reconciliação seguiu',
    );
  }
}

/**
 * Trava a reconciliação para este tenant, com advisory lock do Postgres.
 *
 * ─── O QUE ISTO IMPEDE ──────────────────────────────────────────────────────
 *
 * Duas reconciliações simultâneas — o poll e o aviso de pub/sub chegando junto,
 * ou dois workers durante um deploy que sobrepõe containers — podem intercalar
 * leitura e escrita e deixar o Redis com uma revisão ANTIGA depois de uma nova já
 * ter sido aplicada. O sintoma seria o pior possível: a tela mostrando "aplicado"
 * num horário que não é o que vai disparar.
 *
 * `pg_try_advisory_lock` (não a versão bloqueante): se outra reconciliação está
 * em curso, esta desiste em vez de enfileirar. Não perde nada — a que está
 * rodando lê a mesma tabela e vai aplicar a mesma revisão, ou o próximo poll
 * pega.
 *
 * Lock de SESSÃO, liberado no `finally`. Como o pool reusa conexões, esquecer o
 * unlock deixaria o lock vivo numa conexão ociosa e travaria toda reconciliação
 * seguinte até o processo morrer.
 */
export async function comTravaDeReconciliacao<T>(fn: () => Promise<T>): Promise<T | 'ocupado'> {
  const tid = await tenantIdDaAgenda();
  const client = await pgPool.connect();
  try {
    const { rows } = await client.query<{ travou: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext('agenda:' || $1::text)) AS travou",
      [tid],
    );
    if (!rows[0]?.travou) return 'ocupado';
    try {
      return await fn();
    } finally {
      await client
        .query("SELECT pg_advisory_unlock(hashtext('agenda:' || $1::text))", [tid])
        .catch((err) => logger.error({ err }, 'Falha ao liberar a trava de reconciliação'));
    }
  } finally {
    client.release();
  }
}
