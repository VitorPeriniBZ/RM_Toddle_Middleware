import { tenantConfig } from '@rm-toddle/config';
import { pgPool } from './pool';
import type { Executor } from './executor';

/** Config da escola atendida por este processo. */
const cfg = tenantConfig;

/**
 * `audit_event` — a trilha de "quem mudou o quê, quando, e com base em quê".
 *
 * ─── POR QUE ESTE MÓDULO NÃO ENGOLE ERRO ────────────────────────────────────
 *
 * Todo o resto deste repositório que grava rastro — `job_run`, heartbeat, alerta
 * — foi escrito para NUNCA lançar: observabilidade não pode derrubar a execução
 * que observa. Aqui a regra se INVERTE, e é deliberado.
 *
 * `registrarEvento` recebe um `Executor` e é chamado DENTRO da transação da
 * mudança. Se a gravação falhar, a transação inteira falha e a mudança não
 * acontece. Auditoria "de melhor esforço" é exatamente como uma tabela de
 * auditoria fica vazia enquanto todos acham que ela está funcionando — e a
 * `audit_event` deste banco ficou vazia por meses, com o schema pronto desde a
 * migration 006.
 *
 * A troca é honesta e o preço é pequeno: uma mudança de horário que não pôde ser
 * registrada é uma mudança que ninguém vai conseguir explicar depois. Melhor não
 * ter acontecido.
 *
 * A migration 017 fecha o outro lado: a tabela recusa UPDATE, DELETE e TRUNCATE
 * no banco, não só por contrato em comentário.
 *
 * ─── GRANULARIDADE ──────────────────────────────────────────────────────────
 *
 * Uma linha por DECISÃO humana ou mudança de configuração — não uma por aluno
 * sincronizado. O `runRepository` já explica por quê: 255 alunos × 4 runs por dia
 * de "sucesso" seria volume, custo e discussão de LGPD sem responder nenhuma
 * pergunta que alguém tenha.
 */

/** Quem agiu. Formato do comentário da migration 006, mantido. */
export type Ator = `user:${string}` | 'system/cli' | `worker:${string}`;

export interface EventoDeAuditoria {
  ator: Ator;
  /** Verbo em ponto: `agenda.alterada`, `mapping.proposto`, `operacao.decidida`. */
  acao: string;
  entidade?: string;
  entidadeId?: string;
  antes?: unknown;
  depois?: unknown;
  motivo?: string;
  correlacaoId?: string;
  resultado?: string;
}

let tenantIdCache: string | null = null;
async function tenantId(exec: Executor): Promise<string> {
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

/**
 * Grava o evento. LANÇA em caso de falha — ver o cabeçalho deste arquivo.
 *
 * Passe o `client` da transação da mudança, não o pool: é a única forma de
 * garantir que mudança e trilha vivem ou morrem juntas.
 */
export async function registrarEvento(exec: Executor, ev: EventoDeAuditoria): Promise<void> {
  await exec.query(
    `INSERT INTO audit_event
       (tenant_id, ator, acao, entidade, entidade_id, antes, depois, motivo, correlacao_id, resultado)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      await tenantId(exec),
      ev.ator,
      ev.acao,
      ev.entidade ?? null,
      ev.entidadeId ?? null,
      ev.antes === undefined ? null : JSON.stringify(ev.antes),
      ev.depois === undefined ? null : JSON.stringify(ev.depois),
      ev.motivo ?? null,
      ev.correlacaoId ?? null,
      ev.resultado ?? null,
    ],
  );
}

export interface EventoLido extends EventoDeAuditoria {
  id: string;
  ocorridoEm: string;
  /** Preenchido quando o ator é `user:<uuid>` e a identidade ainda existe. */
  quem?: string;
}

/**
 * Os últimos eventos, para a tela mostrar o histórico junto do controle.
 *
 * Sem isso a trilha só existiria para quem abre o psql — e uma auditoria que
 * ninguém lê não muda comportamento de ninguém. O JOIN com `user_identity`
 * resolve `user:<uuid>` para e-mail, porque UUID na tela não é resposta.
 */
export async function ultimosEventos(limite = 50): Promise<EventoLido[]> {
  const max = Math.min(Math.max(limite, 1), 200);
  const { rows } = await pgPool.query<{
    id: string; ocorrido_em: Date; ator: string; acao: string;
    entidade: string | null; entidade_id: string | null;
    antes: unknown; depois: unknown; motivo: string | null;
    correlacao_id: string | null; resultado: string | null;
    quem: string | null;
  }>(
    `SELECT a.id::text, a.ocorrido_em, a.ator, a.acao, a.entidade, a.entidade_id,
            a.antes, a.depois, a.motivo, a.correlacao_id, a.resultado,
            COALESCE(u.email, u.nome, u.subject) AS quem
       FROM audit_event a
       JOIN tenant t ON t.id = a.tenant_id
       LEFT JOIN user_identity u
              ON a.ator LIKE 'user:%' AND u.id::text = substring(a.ator from 6)
      WHERE t.slug = $1
      ORDER BY a.ocorrido_em DESC
      LIMIT $2`,
    [cfg.slug, max],
  );
  return rows.map((r) => ({
    id: r.id,
    ocorridoEm: new Date(r.ocorrido_em).toISOString(),
    ator: r.ator as Ator,
    acao: r.acao,
    entidade: r.entidade ?? undefined,
    entidadeId: r.entidade_id ?? undefined,
    antes: r.antes ?? undefined,
    depois: r.depois ?? undefined,
    motivo: r.motivo ?? undefined,
    correlacaoId: r.correlacao_id ?? undefined,
    resultado: r.resultado ?? undefined,
    quem: r.quem ?? undefined,
  }));
}
