import { createHash, randomBytes } from 'node:crypto';
import { logger, tenantConfig as cfg } from '@rm-toddle/config';
import { pgPool } from './pool';

// Mesmo padrão dos outros repositórios deste pacote: o id do tenant é resolvido
// uma vez e guardado. Ele não muda durante a vida do processo.
let tenantIdCache: string | null = null;
async function tenantId(): Promise<string> {
  if (tenantIdCache) return tenantIdCache;
  const { rows } = await pgPool.query<{ id: string }>(
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
 * Sessão do plano de controle.
 *
 * ─── O QUE ELA SUBSTITUI ────────────────────────────────────────────────────
 *
 * A "sessão" era o ID token do Google guardado em memória no navegador. Expira
 * em 1 hora (prazo do Google) e sumia a cada recarregar de página. E não havia
 * como DESLOGAR ninguém: um token copiado valia até vencer.
 *
 * ─── O COOKIE LEVA O SEGREDO; A TABELA GUARDA O HASH ────────────────────────
 *
 * 32 bytes aleatórios vão para o cookie; aqui fica o sha256 deles. Um dump da
 * tabela não entrega sessão nenhuma, porque o hash não serve como cookie.
 *
 * ─── DOIS PRAZOS, E ELES FAZEM COISAS DIFERENTES ────────────────────────────
 *
 * `ocioso_ate` desliza a cada uso: é o "esqueci a aba aberta". `expira_em` NÃO
 * desliza: é o teto de vida, e é o que garante que a sessão termina mesmo em
 * uso contínuo. Sem o segundo, uma aba aberta para sempre é uma sessão eterna.
 *
 * Os prazos são generosos de propósito. Com revogação no banco, cortar um
 * acesso é imediato — então eles são decisão de EXPERIÊNCIA, não de contenção.
 */

/** Desliza o ocioso no máximo a cada 5 min: escrever a cada request seria um UPDATE por request. */
const THROTTLE_MS = 5 * 60_000;

export interface Sessao {
  id: string;
  subject: string;
  email: string | null;
  ociosoAte: Date;
  expiraEm: Date;
  vistaEm: Date;
}

export function hashDoToken(cru: string): string {
  return createHash('sha256').update(cru).digest('hex');
}

export interface NovaSessao {
  cru: string;
  sessao: Sessao;
}

export async function criarSessao(
  subject: string,
  email: string | null,
  ociosoMs: number,
  absolutoMs: number,
  origem: { ip?: string; userAgent?: string },
): Promise<NovaSessao> {
  const cru = randomBytes(32).toString('base64url');
  const agora = Date.now();

  const { rows } = await pgPool.query<{
    id: string; ocioso_ate: Date; expira_em: Date; vista_em: Date;
  }>(
    `INSERT INTO sessao (tenant_id, token_hash, subject, email, ocioso_ate, expira_em, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, ocioso_ate, expira_em, vista_em`,
    [
      await tenantId(),
      hashDoToken(cru),
      subject,
      email,
      new Date(agora + ociosoMs),
      new Date(agora + absolutoMs),
      origem.ip ?? null,
      origem.userAgent?.slice(0, 500) ?? null,
    ],
  );

  const r = rows[0];
  return {
    cru,
    sessao: { id: r.id, subject, email, ociosoAte: r.ocioso_ate, expiraEm: r.expira_em, vistaEm: r.vista_em },
  };
}

/**
 * A sessão viva desse cookie, ou `null`.
 *
 * "Não existe", "revogada", "ociosa demais" e "velha demais" devolvem o MESMO
 * resultado: quem chama não deve poder distinguir os casos.
 */
export async function sessaoAtiva(cru: string | undefined): Promise<Sessao | null> {
  if (!cru) return null;

  const { rows } = await pgPool.query<{
    id: string; subject: string; email: string | null;
    ocioso_ate: Date; expira_em: Date; vista_em: Date;
  }>(
    `SELECT id, subject, email, ocioso_ate, expira_em, vista_em
       FROM sessao
      WHERE token_hash = $1
        AND revogada_em IS NULL
        AND ocioso_ate > now()
        AND expira_em  > now()`,
    [hashDoToken(cru)],
  );

  const r = rows[0];
  if (!r) return null;
  return { id: r.id, subject: r.subject, email: r.email, ociosoAte: r.ocioso_ate, expiraEm: r.expira_em, vistaEm: r.vista_em };
}

/**
 * Desliza o prazo de inatividade. Chamar SEM `await`.
 *
 * Manter a sessão viva não deve atrasar a resposta, e falhar aqui só significa
 * que ela desliza no próximo request. O `LEAST` é o que impede o ocioso de
 * ultrapassar o teto absoluto.
 */
export async function tocarSessao(s: Sessao, ociosoMs: number): Promise<void> {
  if (Date.now() - s.vistaEm.getTime() < THROTTLE_MS) return;
  try {
    await pgPool.query(
      `UPDATE sessao
          SET vista_em = now(),
              ocioso_ate = LEAST(now() + ($2 || ' milliseconds')::interval, expira_em)
        WHERE id = $1`,
      [s.id, String(ociosoMs)],
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message, sessao: s.id }, 'Não consegui deslizar o prazo da sessão');
  }
}

/**
 * Revoga a sessão A QUE UM COOKIE PERTENCE.
 *
 * É o caminho do logout, que é onde só se tem o valor do cookie — e não pode
 * exigir sessão válida, porque sair da conta não pode falhar.
 *
 * Revogar, e não só limpar o cookie: limpar apaga o cookie do navegador de quem
 * está saindo e deixa intacta qualquer CÓPIA que alguém tenha levado.
 *
 * Devolve o subject e o id da sessão encerrada, para a auditoria.
 */
export async function revogarPorToken(
  cru: string | undefined,
  porQue: string,
): Promise<{ id: string; subject: string } | null> {
  if (!cru) return null;
  const { rows } = await pgPool.query<{ id: string; subject: string }>(
    `UPDATE sessao SET revogada_em = now(), revogada_por_que = $2
      WHERE token_hash = $1 AND revogada_em IS NULL
      RETURNING id, subject`,
    [hashDoToken(cru), porQue],
  );
  return rows[0] ?? null;
}

/** Revoga UMA sessão pelo id. */
export async function revogarSessao(id: string, porQue: string): Promise<void> {
  await pgPool.query(
    `UPDATE sessao SET revogada_em = now(), revogada_por_que = $2 WHERE id = $1 AND revogada_em IS NULL`,
    [id, porQue],
  );
}

/**
 * Derruba TODAS as sessões de alguém. O botão que faltava.
 *
 * `excetoId` serve para "encerrar as outras sessões", em que a pessoa não quer
 * se deslogar do aparelho em que está.
 */
export async function revogarTodasDe(
  subject: string,
  porQue: string,
  opts: { excetoId?: string } = {},
): Promise<number> {
  const { rowCount } = await pgPool.query(
    `UPDATE sessao SET revogada_em = now(), revogada_por_que = $3
      WHERE tenant_id = $1 AND subject = $2 AND revogada_em IS NULL
        AND ($4::uuid IS NULL OR id <> $4)`,
    [await tenantId(), subject, porQue, opts.excetoId ?? null],
  );
  return rowCount ?? 0;
}

/** As sessões vivas de alguém, para a tela "meus acessos". */
export async function sessoesVivasDe(subject: string): Promise<
  { id: string; criadaEm: Date; vistaEm: Date; expiraEm: Date; ip: string | null; userAgent: string | null }[]
> {
  const { rows } = await pgPool.query(
    `SELECT id, criada_em AS "criadaEm", vista_em AS "vistaEm", expira_em AS "expiraEm", ip, user_agent AS "userAgent"
       FROM sessao
      WHERE tenant_id = $1 AND subject = $2 AND revogada_em IS NULL
        AND ocioso_ate > now() AND expira_em > now()
      ORDER BY vista_em DESC`,
    [await tenantId(), subject],
  );
  return rows;
}

/**
 * Limpeza.
 *
 * Só apaga o que morreu há mais de uma semana: a linha revogada ou expirada é
 * justamente o registro que interessa numa investigação, e apagá-la na hora do
 * vencimento jogaria fora a resposta para "de onde e até quando esse acesso
 * funcionou".
 */
export async function apagarSessoesMortas(): Promise<number> {
  const { rowCount } = await pgPool.query(
    `DELETE FROM sessao WHERE expira_em < now() - interval '7 days'`,
  );
  return rowCount ?? 0;
}
