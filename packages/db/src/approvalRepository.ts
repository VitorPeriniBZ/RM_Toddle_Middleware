import { logger, tenantConfig } from '@rm-toddle/config';
import { PAPEIS_QUE_APROVAM, quantosPodemAprovar } from './accessRepository';
import { pgPool } from './pool';

/** Config da escola atendida por este processo. */
const cfg = tenantConfig;

/**
 * Gate de aprovação humana para escrita no RM.
 *
 * Usa `operation` e `approval` da migration 006, que existem exatamente para
 * isto — e desde a migration 011 `operation` serve SÓ para isto: os estados de
 * execução (`executing`/`succeeded`/`failed`) saíram do CHECK e foram para
 * `job_run`. Aprovação é máquina de estados; execução é evento.
 *
 * ─── A TENSÃO DO SCHEMA, E COMO ELA SE RESOLVE ──────────────────────────────
 *
 * A migration 006 comenta, sobre `approval`:
 *
 *   "Quem propõe não aprova a própria operação: garantido na aplicação, porque
 *    aqui não há acesso a operation.criado_por dentro do CHECK."
 *
 * Segregação de funções, e é a regra certa numa equipe com mais de uma pessoa.
 * Aqui é uma. Cumprir ao pé da letra tornaria o gate inutilizável, e ignorar em
 * silêncio seria pior — apagaria uma decisão de projeto sem registro.
 *
 * A resolução, e ela é honesta:
 *
 *   1. Run de CRON não tem proponente. `criado_por` é NULL: quem propôs foi o
 *      scheduler. Não há de quem segregar, e aprovar é permitido. Este é o caso
 *      real — o writer roda agendado.
 *   2. Operação com `criado_por` PREENCHIDO só pode ser aprovada por OUTRA
 *      identidade. A regra vale onde ela significa algo, e é imposta abaixo.
 *
 * Para uma pessoa, o valor do gate não é controle de duas mãos. É **confirmação
 * humana deliberada e registrada**: alguém leu "este run quer escrever 3.000
 * linhas" e disse sim, com nome e motivo, e isso fica no banco.
 *
 * ─── IDENTIDADE DE LINHA DE COMANDO ─────────────────────────────────────────
 *
 * `approval.approver_id` referencia `user_identity`, que é chaveada por
 * `(provider, subject)` e foi desenhada para o Google OIDC. Uma aprovação por CLI
 * usa `provider='cli'` e `subject` = quem digitou. É identidade de verdade, só
 * não federada — e resolver na hora evita exigir um cadastro que ninguém fez
 * (a tabela está vazia) antes de a primeira aprovação ser possível.
 */

export interface PlanoParaAprovar {
  /** Chave do run que propôs. Vira a `idempotency_key` da operação. */
  chave: string;
  tipo: string;
  /** O plano e os motivos, para quem aprova ler sem abrir código. */
  payload: Record<string, unknown>;
}

export interface OperacaoPendente {
  id: string;
  tipo: string;
  chave: string;
  payload: Record<string, unknown>;
  criadoPor?: string;
  criadoEm: string;
}

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
  const resolvido = rows[0].id;
  tenantIdCache = resolvido;
  return resolvido;
}

/**
 * Resolve (criando se preciso) a identidade de quem opera pela linha de comando.
 *
 * `subject` é o texto que a pessoa passou em `--quem`. Não há verificação: numa
 * CLI, quem tem acesso ao terminal tem acesso. O valor está em o nome ficar
 * gravado ao lado da decisão, não em provar quem é.
 */
export async function identidadeDeCli(quem: string): Promise<string> {
  const { rows } = await pgPool.query<{ id: string }>(
    `INSERT INTO user_identity (provider, subject, nome)
     VALUES ('cli', $1, $1)
     ON CONFLICT (provider, subject) DO UPDATE SET subject = EXCLUDED.subject
       -- upsert-preserva: para ator de CLI, nome E o proprio subject (os dois
       -- recebem $1), entao nao ha valor novo possivel a gravar.
     RETURNING id`,
    [quem.trim()],
  );
  return rows[0].id;
}

/**
 * Põe o run em `needs_review` e para.
 *
 * Cria (ou reusa) a linha em `operation` com a MESMA chave do run que a propôs —
 * então uma proposta por run, e reexecutar o run não empilha pedidos.
 */
export async function pedirAprovacao(plano: PlanoParaAprovar): Promise<void> {
  await pgPool.query(
    `INSERT INTO operation (tenant_id, tipo, estado, payload, idempotency_key)
     VALUES ($1, $2, 'needs_review', $3, $4)
     ON CONFLICT (tenant_id, idempotency_key)
     DO UPDATE SET estado = 'needs_review', payload = EXCLUDED.payload, updated_at = now()
       -- upsert-preserva: tipo e determinado pela chave de idempotencia, que e
       -- a chave do run que propos — a mesma chave nao muda de tipo.`,
    [await tenantId(), plano.tipo, JSON.stringify(plano.payload), plano.chave],
  );
}

/** As operações esperando decisão humana. */
export async function operacoesPendentes(): Promise<OperacaoPendente[]> {
  const { rows } = await pgPool.query<{
    id: string;
    tipo: string;
    idempotency_key: string;
    payload: Record<string, unknown>;
    criado_por: string | null;
    created_at: Date;
  }>(
    `SELECT id, tipo, idempotency_key, payload, criado_por, created_at
       FROM operation
      WHERE tenant_id = $1 AND estado = 'needs_review'
      ORDER BY created_at DESC`,
    [await tenantId()],
  );
  return rows.map((r) => ({
    id: r.id,
    tipo: r.tipo,
    chave: r.idempotency_key,
    payload: r.payload ?? {},
    criadoPor: r.criado_por ?? undefined,
    criadoEm: new Date(r.created_at).toISOString(),
  }));
}

export type ResultadoDecisao =
  | { ok: true; estado: 'approved' | 'rejected' }
  | { ok: false; erro: string };

/**
 * Registra a decisão humana.
 *
 * Grava em `approval` **e** move `operation.estado`, numa transação: aprovar sem
 * registrar quem aprovou, ou registrar sem liberar, deixaria o gate num estado em
 * que ninguém confia.
 *
 * A recusa de auto-aprovação acontece aqui, onde `criado_por` está visível — foi
 * exatamente o que o comentário da migration 006 disse que teria de ser feito na
 * aplicação, porque o CHECK não alcança.
 */
export async function decidirOperacao(
  operationId: string,
  quem: string,
  decisao: 'approved' | 'rejected',
  motivo: string,
): Promise<ResultadoDecisao> {
  // A identidade é resolvida FORA da transação da decisão: é um upsert
  // independente, e mantê-lo dentro só aumentaria o tempo de vida do `FOR UPDATE`
  // sobre a operação.
  return decidirOperacaoPorIdentidade(operationId, await identidadeDeCli(quem), decisao, motivo);
}

/**
 * A decisão, a partir de uma identidade JÁ resolvida.
 *
 * Existe porque agora há dois caminhos para decidir: a CLI (`npm run aprovar`,
 * que resolve `provider='cli'`) e a tela (que resolve `provider='google'` pela
 * claim `sub`). A regra de segregação, a transação e o registro em `approval` são
 * os mesmos — duplicá-los por caminho seria a forma mais fácil de eles
 * divergirem.
 */
export async function decidirOperacaoPorIdentidade(
  operationId: string,
  aprovador: string,
  decisao: 'approved' | 'rejected',
  motivo: string,
): Promise<ResultadoDecisao> {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const tid = await tenantId();

    const { rows } = await client.query<{ criado_por: string | null; estado: string }>(
      `SELECT criado_por, estado FROM operation
        WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tid, operationId],
    );
    const op = rows[0];
    if (!op) {
      await client.query('ROLLBACK');
      return { ok: false, erro: 'operação não encontrada neste tenant' };
    }
    if (op.estado !== 'needs_review') {
      await client.query('ROLLBACK');
      return { ok: false, erro: `operação está em "${op.estado}", não em "needs_review"` };
    }

    // ─── SEGREGAÇÃO DE FUNÇÕES, ONDE ELA SIGNIFICA ALGO ────────────────────
    //
    // Run de cron tem `criado_por` NULL: o scheduler propôs, e não há de quem
    // segregar. Este era o único caso quando só existia a CLI.
    //
    // A TELA muda isso, e o problema é real: uma proposta de vínculo feita pela
    // interface tem proponente registrado (é a verdade, e registrá-la é o
    // objetivo), então a regra passaria a bloquear o único dev do projeto de
    // decidir sobre a própria proposta — tornando a função inutilizável, que é
    // pior do que não tê-la.
    //
    // A EXCEÇÃO, e ela segue o mesmo raciocínio da regra: com UMA identidade
    // capaz de aprovar neste tenant, exigir "outra pessoa" não protege ninguém,
    // porque não existe outra pessoa. Não há de quem segregar — igual ao run de
    // cron. Com duas ou mais, a regra volta a ter conteúdo e é imposta.
    //
    // O controle que permanece nos dois casos é o que de fato pega o dedo errado:
    // dois PASSOS separados, com o diff à vista e o snapshot revalidado, e a
    // decisão gravada com nome e motivo. Nunca foi o controle de duas mãos que
    // fazia esta função valer a pena para uma pessoa só.
    if (op.criado_por && op.criado_por === aprovador) {
      const aprovadores = await quantosPodemAprovar(client);
      // EXATAMENTE um aprovador libera; zero NÃO.
      //
      // A distinção é o que separa a exceção de um buraco. "Zero identidades com
      // papel de aprovação" não quer dizer "existe uma pessoa só" — quer dizer
      // que `membership` nunca foi preenchida, que é o estado ATUAL do tenant
      // real. Com `<= 1`, a regra desapareceria em silêncio justamente onde
      // ninguém configurou nada, e ficaria aberta até alguém lembrar de conceder
      // papéis. Com `=== 1`, a exceção só existe depois de alguém dizer, por
      // escrito, quem aprova.
      if (aprovadores !== 1) {
        await client.query('ROLLBACK');
        return {
          ok: false,
          erro:
            'quem propôs a operação não pode aprová-la. Este tenant tem ' +
            `${aprovadores} identidades com papel de aprovação (${PAPEIS_QUE_APROVAM.join(' ou ')}), ` +
            'então a decisão precisa de outra pessoa. (Run agendado não tem proponente e ' +
            'pode ser aprovado por quem opera.)',
        };
      }
      logger.warn(
        { operationId, aprovador, aprovadores },
        'AUTO-APROVAÇÃO permitida: há uma única identidade capaz de aprovar neste tenant. ' +
          'A segregação de funções não tem a quem segregar; o controle que resta são os dois ' +
          'passos e o registro da decisão',
      );
    }

    await client.query(
      `INSERT INTO approval (operation_id, approver_id, decisao, motivo)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (operation_id, approver_id)
       DO UPDATE SET decisao = EXCLUDED.decisao, motivo = EXCLUDED.motivo, decidido_em = now()`,
      [operationId, aprovador, decisao, motivo],
    );
    // `rejected`, não `failed`: recusa é uma DECISÃO humana registrada, não uma
    // falha de execução. A primeira versão gravava `failed` porque o CHECK antigo
    // de `operation` aceitava — herança de quando esta tabela também servia de
    // registro de run. A migration 011 tirou os estados de execução do CHECK e
    // isto passou a ser recusado pelo banco, que é o comportamento certo.
    await client.query(
      `UPDATE operation SET estado = $2, updated_at = now() WHERE id = $1`,
      [operationId, decisao === 'approved' ? 'approved' : 'rejected'],
    );
    await client.query('COMMIT');
    return { ok: true, estado: decisao };
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err, operationId }, 'Falha ao registrar a decisão');
    return { ok: false, erro: (err as Error).message };
  } finally {
    client.release();
  }
}

/**
 * O run foi aprovado por um humano?
 *
 * O writer chama isto antes de escrever. `approved` é estado terminal do gate: o
 * run recomeça, encontra a aprovação e executa sem pedir de novo.
 */
export async function estaAprovado(chave: string): Promise<boolean> {
  try {
    const { rows } = await pgPool.query<{ estado: string }>(
      `SELECT estado FROM operation WHERE tenant_id = $1 AND idempotency_key = $2`,
      [await tenantId(), chave],
    );
    return rows[0]?.estado === 'approved';
  } catch (err) {
    // Fail-closed: se não dá para saber se foi aprovado, não foi.
    logger.warn({ err: (err as Error).message, chave }, 'Não foi possível checar a aprovação');
    return false;
  }
}
