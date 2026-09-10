import { tenantConfig } from '@rm-toddle/config';
import { pgPool } from './pool';
import type { Executor } from './executor';

/** Config da escola atendida por este processo. */
const cfg = tenantConfig;

/**
 * IDENTIDADE e AUTORIZAÇÃO — as duas coisas que a API tinha o schema para fazer
 * e não fazia.
 *
 * ─── A DISTINÇÃO QUE ESTE MÓDULO EXISTE PARA MANTER ─────────────────────────
 *
 * `apps/api/src/auth.ts` responde "quem é": valida a assinatura do token do
 * Google, a audience, a expiração e a claim `hd` do Workspace da escola. É
 * AUTENTICAÇÃO, e o próprio arquivo diz, desde o primeiro dia, que pertencer ao
 * Workspace não é autorização.
 *
 * Este módulo responde "pode o quê", e a resposta vem da tabela `membership`
 * (migration 006) — nunca do domínio do e-mail. A diferença não é acadêmica:
 * todo mundo da escola autentica, e "todo mundo da escola" não é "quem pode
 * mudar o job que escreve nota no RM". Se alunos tiverem conta no mesmo domínio,
 * a distância entre as duas frases é a superfície inteira do sistema.
 *
 * ─── NEGAÇÃO POR PADRÃO ─────────────────────────────────────────────────────
 *
 * Sem linha em `membership`, o usuário não tem papel nenhum e nenhuma rota
 * protegida responde — nem as de leitura. A tabela nasce vazia, então o primeiro
 * acesso é concedido por SCRIPT (`npm run conceder`), fora da tela. Não é
 * esquecimento: uma tela que pudesse conceder o primeiro papel a si mesma não
 * seria uma porta trancada, seria uma porta com a chave na fechadura.
 */

/** Papéis aceitos pelo CHECK de `membership` (migration 006). */
export const PAPEIS = [
  'viewer',
  'mapping_manager',
  'integration_operator',
  'approver',
  'tenant_admin',
] as const;
export type Papel = (typeof PAPEIS)[number];

/** Papéis que podem decidir uma operação. Usado na exceção de auto-aprovação. */
export const PAPEIS_QUE_APROVAM: Papel[] = ['approver', 'tenant_admin'];

export interface IdentidadeGoogle {
  /** Claim `sub`. É a identidade estável — e-mail muda, `sub` não. */
  subject: string;
  email?: string;
  nome?: string;
}

let tenantIdCache: string | null = null;
async function tenantId(exec: Executor = pgPool): Promise<string> {
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
 * Resolve (criando se preciso) a `user_identity` de quem entrou pelo Google.
 *
 * A chave é `(provider, subject)`, NUNCA o e-mail: e-mail muda por casamento,
 * correção de grafia e mudança de domínio, e reaproveitar e-mail como chave faz
 * o histórico de auditoria apontar para a pessoa errada. `email` e `nome` são
 * atualizados a cada login porque são informativos — servem para a tela mostrar
 * um humano em vez de um UUID.
 *
 * Criar a identidade no login NÃO concede nada: papel vem de `membership`, que
 * continua vazia até alguém conceder.
 */
export async function identidadeDoGoogle(
  id: IdentidadeGoogle,
  exec: Executor = pgPool,
): Promise<string> {
  const { rows } = await exec.query<{ id: string }>(
    `INSERT INTO user_identity (provider, subject, email, nome)
     VALUES ('google', $1, $2, $3)
     ON CONFLICT (provider, subject)
     DO UPDATE SET email = COALESCE(EXCLUDED.email, user_identity.email),
                   nome  = COALESCE(EXCLUDED.nome,  user_identity.nome)
     RETURNING id`,
    [id.subject, id.email ?? null, id.nome ?? null],
  );
  return rows[0].id;
}

/**
 * Cache curto dos papéis.
 *
 * Uma consulta por requisição seria barata, mas a tela faz várias chamadas por
 * tela carregada e o número multiplica sem precisar. 30 segundos é curto o
 * suficiente para que REVOGAR um papel tenha efeito quase imediato — que é a
 * direção que importa: conceder pode esperar meio minuto, revogar não deveria.
 */
const TTL_PAPEIS_MS = 30_000;
const cachePapeis = new Map<string, { papeis: Papel[]; expiraEm: number }>();

/** Os papéis do usuário NESTE tenant. Vazio = sem acesso. */
export async function papeisDoUsuario(userIdentityId: string, exec: Executor = pgPool): Promise<Papel[]> {
  const agora = Date.now();
  const emCache = cachePapeis.get(userIdentityId);
  if (emCache && emCache.expiraEm > agora) return emCache.papeis;

  const { rows } = await exec.query<{ papel: Papel }>(
    `SELECT DISTINCT papel FROM membership
      WHERE user_identity_id = $1 AND tenant_id = $2`,
    [userIdentityId, await tenantId(exec)],
  );
  const papeis = rows.map((r) => r.papel);
  cachePapeis.set(userIdentityId, { papeis, expiraEm: agora + TTL_PAPEIS_MS });
  return papeis;
}

/** Esvazia o cache de papéis. Chamado ao conceder ou revogar, e pelos testes. */
export function limparCacheDePapeis(): void {
  cachePapeis.clear();
}

/**
 * Concede um papel. Existe para o SCRIPT de bootstrap, não para a tela.
 *
 * `campus_id` fica NULL = todos os campi. Enquanto a escola em escopo tem um
 * campus só, dividir por campus seria complexidade sem pergunta que a exija — e
 * a coluna já está lá para o dia em que exigir.
 */
export async function concederPapel(
  identidade: IdentidadeGoogle & { provider?: 'google' | 'cli' },
  papel: Papel,
): Promise<{ userIdentityId: string; jaTinha: boolean }> {
  const provider = identidade.provider ?? 'google';
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const { rows: idRows } = await client.query<{ id: string }>(
      `INSERT INTO user_identity (provider, subject, email, nome)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (provider, subject)
       DO UPDATE SET email = COALESCE(EXCLUDED.email, user_identity.email),
                     nome  = COALESCE(EXCLUDED.nome,  user_identity.nome)
       RETURNING id`,
      [provider, identidade.subject, identidade.email ?? null, identidade.nome ?? null],
    );
    const userIdentityId = idRows[0].id;

    const { rowCount } = await client.query(
      `INSERT INTO membership (user_identity_id, tenant_id, campus_id, papel)
       VALUES ($1, $2, NULL, $3)
       ON CONFLICT (user_identity_id, tenant_id, campus_id, papel) DO NOTHING`,
      [userIdentityId, await tenantId(client), papel],
    );
    await client.query('COMMIT');
    limparCacheDePapeis();
    return { userIdentityId, jaTinha: (rowCount ?? 0) === 0 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Quem tem acesso a este tenant, para a tela e para o script listar. */
export async function listarAcessos(): Promise<
  Array<{ userIdentityId: string; provider: string; subject: string; email: string | null; nome: string | null; papeis: Papel[] }>
> {
  const { rows } = await pgPool.query<{
    id: string; provider: string; subject: string; email: string | null; nome: string | null; papeis: Papel[];
  }>(
    `SELECT u.id, u.provider, u.subject, u.email, u.nome,
            array_agg(DISTINCT m.papel)::text[] AS papeis
       FROM membership m
       JOIN user_identity u ON u.id = m.user_identity_id
      WHERE m.tenant_id = $1
      GROUP BY u.id, u.provider, u.subject, u.email, u.nome
      ORDER BY u.email NULLS LAST, u.subject`,
    [await tenantId()],
  );
  return rows.map((r) => ({
    userIdentityId: r.id,
    provider: r.provider,
    subject: r.subject,
    email: r.email,
    nome: r.nome,
    papeis: r.papeis,
  }));
}

/**
 * Quantas identidades podem aprovar neste tenant.
 *
 * Alimenta a exceção de auto-aprovação: com um único aprovador, exigir "outra
 * pessoa" não protege ninguém, só torna o gate inutilizável. Ver a decisão
 * inteira em `approvalRepository.decidirOperacaoPorIdentidade`.
 */
export async function quantosPodemAprovar(exec: Executor = pgPool): Promise<number> {
  const { rows } = await exec.query<{ n: string }>(
    `SELECT count(DISTINCT user_identity_id)::text AS n
       FROM membership
      WHERE tenant_id = $1 AND papel = ANY($2::text[])`,
    [await tenantId(exec), PAPEIS_QUE_APROVAM],
  );
  return Number(rows[0]?.n ?? 0);
}
