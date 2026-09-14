import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { tenantConfig } from '@rm-toddle/config';
import {
  decidirOperacao, estaAprovado, identidadeDeCli, operacoesPendentes, pedirAprovacao,
} from './approvalRepository';
import { quantosPodemAprovar } from './accessRepository';
import { abrirRun } from './runRepository';
import { pgPool } from './pool';

/**
 * O gate de aprovação, contra Postgres DE VERDADE.
 *
 * `decidirOperacao` grava em `approval` E move `operation.estado` numa
 * transação, com `SELECT ... FOR UPDATE`. Aprovar sem registrar quem aprovou, ou
 * registrar sem liberar, deixaria o gate num estado em que ninguém confia — e
 * isso não se verifica sem banco.
 */

/**
 * ZERA os papéis do tenant da suíte antes de cada teste.
 *
 * ─── POR QUE APAGAR TUDO, E NÃO SÓ O QUE ESTE ARQUIVO CRIOU ─────────────────
 *
 * `quantosPodemAprovar` conta o TENANT INTEIRO, e é esse número que decide se a
 * auto-aprovação é recusada. Limpar só o próprio prefixo deixa cada arquivo à
 * mercê do que os outros esquecerem: três arquivos desta suíte criam papel de
 * aprovação, e a falha resultante aparece como "expected true to be false", sem
 * nada apontando para a causa. Foi assim que uma falha intermitente sobreviveu
 * dias — passava dez vezes isolada e caía na suíte inteira.
 *
 * É seguro apagar tudo porque o tenant é EXCLUSIVO da suíte: o `globalSetup`
 * recusa subir se `TENANT_SLUG` não for `integracao-teste`, justamente para que
 * limpezas como esta nunca alcancem a escola de verdade.
 */
async function zerarPapeisDoTenantDeTeste(): Promise<void> {
  await pgPool.query(
    `delete from membership where tenant_id in
       (select id from tenant where slug = $1)`,
    [tenantConfig.slug],
  );
}

const limpar = async (): Promise<void> => {
  await zerarPapeisDoTenantDeTeste();
  // Ordem obrigatória: `approval.operation_id` é ON DELETE RESTRICT, e o
  // RESTRICT é proposital — aprovação órfã seria registro de decisão sem a
  // decisão.
  await pgPool.query(
    `delete from approval where operation_id in
       (select id from operation where tipo like 'teste.gate%')`,
  );
  await pgPool.query("delete from operation where tipo like 'teste.gate%'");
  // SÓ as identidades que este teste criou.
  //
  // A versão anterior apagava TODA identidade `provider='cli'`, e passou por um
  // ano feliz porque a tabela vivia vazia. Em 24/08/2026 uma aprovação REAL foi
  // registrada (a primeira escrita de frequência no RM), e a suíte inteira caiu:
  // `approval.approver_id` referencia `user_identity`, e o FK — corretamente —
  // recusou apagar a identidade de quem assinou uma decisão de verdade.
  //
  // Teste que limpa por categoria em vez de por posse destrói dado de produção
  // assim que produção passa a existir. E o dado aqui é trilha de auditoria de
  // escrita em ERP de cliente: exatamente o que não se apaga para deixar um teste
  // verde. Daí o prefixo, igual ao que `tipo` já usava.
  // As memberships vêm ANTES das identidades (FK), e limpá-las é o que impede
  // este arquivo de fazer com os outros o que os outros fizeram com ele: um
  // `approver` esquecido aqui muda o comportamento de `decidirOperacao` em
  // qualquer teste que rode depois.
  await pgPool.query(
    `delete from membership where user_identity_id in
       (select id from user_identity where provider = 'cli' and subject like 'teste.gate:%')`,
  );
  await pgPool.query(
    "delete from user_identity where provider = 'cli' and subject like 'teste.gate:%'",
  );
};

beforeEach(limpar);
afterAll(async () => { await limpar(); await pgPool.end(); });

describe('run de cron: sem proponente, aprovável por quem opera', () => {
  it('pede, aparece na fila com o plano, aprova e libera', async () => {
    const chave = 'gate-cron-1';
    await abrirRun({ tipo: 'teste.gate', chave, configVersion: 'v', payload: {} });
    expect(await estaAprovado(chave)).toBe(false);

    await pedirAprovacao({
      chave, tipo: 'teste.gate',
      payload: { aEscrever: 3000, motivos: ['+1400% sobre o histórico'] },
    });
    const [op] = await operacoesPendentes();
    expect(op.payload.aEscrever).toBe(3000);
    expect(op.criadoPor).toBeUndefined(); // o scheduler propôs

    expect((await decidirOperacao(op.id, 'teste.gate:vitor', 'approved', 'conferi com a coordenação')).ok).toBe(true);
    expect(await estaAprovado(chave)).toBe(true);
    expect((await operacoesPendentes()).length).toBe(0);
  });

  it('registra quem, o quê e por quê', async () => {
    const chave = 'gate-cron-2';
    await pedirAprovacao({ chave, tipo: 'teste.gate', payload: {} });
    const [op] = await operacoesPendentes();
    await decidirOperacao(op.id, 'teste.gate:vitor', 'approved', 'volume explicado pela janela maior');

    const { rows } = await pgPool.query<{ decisao: string; motivo: string; subject: string }>(
      `select a.decisao, a.motivo, u.subject from approval a
         join user_identity u on u.id = a.approver_id
         join operation o on o.id = a.operation_id
        where o.idempotency_key = $1`, [chave],
    );
    expect(rows[0]).toMatchObject({ decisao: 'approved', subject: 'teste.gate:vitor' });
    expect(rows[0].motivo).toContain('janela');
  });
});

describe('recusa', () => {
  it('recusado NÃO libera a escrita', async () => {
    const chave = 'gate-cron-3';
    await pedirAprovacao({ chave, tipo: 'teste.gate', payload: {} });
    const [op] = await operacoesPendentes();
    expect((await decidirOperacao(op.id, 'teste.gate:vitor', 'rejected', 'era bug do de-para')).ok).toBe(true);
    expect(await estaAprovado(chave)).toBe(false);
  });

  it('decidir duas vezes não reabre', async () => {
    const chave = 'gate-cron-4';
    await pedirAprovacao({ chave, tipo: 'teste.gate', payload: {} });
    const [op] = await operacoesPendentes();
    await decidirOperacao(op.id, 'teste.gate:vitor', 'rejected', 'primeira');
    const r = await decidirOperacao(op.id, 'teste.gate:vitor', 'approved', 'mudei de ideia');
    expect(r.ok).toBe(false);
  });
});

/**
 * ─── A REGRA DEPENDE DE QUANTOS PODEM APROVAR, E ISSO É TESTADO DE PROPÓSITO ──
 *
 * `decidirOperacao` recusa a auto-aprovação quando o tenant tem 0 ou 2+
 * identidades com papel de aprovação, e a PERMITE quando tem exatamente 1 — com
 * uma pessoa só, exigir "outra pessoa" não protege ninguém.
 *
 * A versão anterior deste bloco não controlava esse número: ela herdava o estado
 * do tenant da suíte, que normalmente tem ZERO membros, e passava por isso. Um
 * único `tenant_admin` deixado por qualquer outro teste — ou por um
 * `npm run conceder` — invertia o resultado e a falha aparecia como
 * "expected true to be false", sem nada apontando para a causa.
 *
 * Aconteceu duas vezes, com dias de intervalo, e na primeira não foi
 * reproduzida: rodada isolada, a suíte passava dez vezes seguidas. Foi
 * acrescentar testes de acesso — que criam `tenant_admin` no mesmo tenant — que
 * tornou o defeito determinístico e revelou que o problema nunca esteve no
 * código de aprovação, e sim num teste que dependia de um número que ninguém
 * declarava.
 *
 * Agora os três ramos são exercitados com o número FIXADO pelo próprio teste.
 */
describe('segregação de funções, onde ela significa algo', () => {
  /**
   * O tenant da suíte começa SEM ninguém capaz de aprovar.
   *
   * Verificado, não suposto: `quantosPodemAprovar` conta o tenant inteiro, então
   * uma linha deixada por outro teste — ou por um `npm run conceder` — muda o
   * ramo que estes três exercitam. Sem esta checagem, a falha aparece como
   * "expected true to be false" e ninguém liga o ponto à causa. Aconteceu.
   */
  beforeEach(async () => {
    expect(
      await quantosPodemAprovar(),
      'o tenant da suíte já tem identidade com papel de aprovação antes destes testes, e é ESSE ' +
        'número que decide se a auto-aprovação é recusada. Limpe `membership` do tenant ' +
        '`integracao-teste` — provavelmente sobrou de outro teste ou de um `npm run conceder`.',
    ).toBe(0);
  });

  /** Dá `approver` a N identidades de CLI. */
  async function comAprovadores(n: number): Promise<void> {
    const { rows: t } = await pgPool.query<{ id: string }>(
      'select id from tenant where slug = $1',
      [tenantConfig.slug],
    );
    for (let i = 0; i < n; i += 1) {
      const id = await identidadeDeCli(`teste.gate:aprovador${i}`);
      await pgPool.query(
        `insert into membership (user_identity_id, tenant_id, campus_id, papel)
         values ($1, $2, NULL, 'approver')
         on conflict (user_identity_id, tenant_id, papel) where campus_id is null do nothing`,
        [id, t[0].id],
      );
    }
  }

  /** Cria a operação com proponente e devolve o id. */
  async function operacaoDe(proponente: string, chave: string): Promise<string> {
    const id = await identidadeDeCli(proponente);
    await pgPool.query(
      `insert into operation (tenant_id, tipo, estado, payload, idempotency_key, criado_por)
       select t.id, 'teste.gate', 'needs_review', '{}'::jsonb, $1, $2
         from tenant t where t.slug = $3`,
      [chave, id, tenantConfig.slug],
    );
    return (await operacoesPendentes()).find((o) => o.chave === chave)!.id;
  }

  it('ZERO aprovadores: recusa — ninguém configurou nada, e a regra não some em silêncio', async () => {
    const op = await operacaoDe('teste.gate:ana', 'gate-proposto-0');
    const auto = await decidirOperacao(op, 'teste.gate:ana', 'approved', 'eu mesma');
    expect(auto.ok).toBe(false);
    expect(auto.ok === false && auto.erro).toMatch(/não pode aprová-la/);

    expect((await decidirOperacao(op, 'teste.gate:vitor', 'approved', 'revisei o plano da ana')).ok).toBe(true);
  });

  it('UM aprovador: permite — não há de quem segregar', async () => {
    await comAprovadores(1);
    const op = await operacaoDe('teste.gate:ana', 'gate-proposto-1');
    // A exceção documentada. O controle que resta são os dois passos e o
    // registro da decisão, que continuam valendo.
    expect((await decidirOperacao(op, 'teste.gate:ana', 'approved', 'eu mesma')).ok).toBe(true);
  });

  it('DOIS aprovadores: recusa — agora a regra tem conteúdo', async () => {
    await comAprovadores(2);
    const op = await operacaoDe('teste.gate:ana', 'gate-proposto-2');
    const auto = await decidirOperacao(op, 'teste.gate:ana', 'approved', 'eu mesma');
    expect(auto.ok).toBe(false);
    expect(auto.ok === false && auto.erro).toMatch(/2 identidades/);

    expect((await decidirOperacao(op, 'teste.gate:vitor', 'approved', 'revisei o plano da ana')).ok).toBe(true);
  });
});

describe('fail-closed', () => {
  it('operação inexistente é recusada', async () => {
    const r = await decidirOperacao('00000000-0000-0000-0000-000000000000', 'teste.gate:v', 'approved', 'x');
    expect(r.ok).toBe(false);
  });

  it('chave inexistente não conta como aprovada', async () => {
    expect(await estaAprovado('chave-que-nao-existe')).toBe(false);
  });
});

describe('identidade de CLI', () => {
  it('é idempotente por nome', async () => {
    const a = await identidadeDeCli('teste.gate:vitor');
    const b = await identidadeDeCli('teste.gate:vitor');
    expect(a).toBe(b);
  });
});
