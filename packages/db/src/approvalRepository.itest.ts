import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { tenantConfig } from '@rm-toddle/config';
import {
  decidirOperacao, estaAprovado, identidadeDeCli, operacoesPendentes, pedirAprovacao,
} from './approvalRepository';
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

const limpar = async (): Promise<void> => {
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

describe('segregação de funções, onde ela significa algo', () => {
  // A migration 006 diz "quem propõe não aprova a própria operação: garantido na
  // aplicação". Run de cron tem `criado_por` NULL e não há de quem segregar;
  // operação com proponente exige outra identidade.
  it('quem propôs NÃO aprova, mas outra pessoa aprova', async () => {
    const proponente = await identidadeDeCli('teste.gate:ana');
    const chave = 'gate-proposto-1';
    await pgPool.query(
      `insert into operation (tenant_id, tipo, estado, payload, idempotency_key, criado_por)
       select t.id, 'teste.gate', 'needs_review', '{}'::jsonb, $1, $2
         from tenant t where t.slug = $3`,
      [chave, proponente, tenantConfig.slug],
    );
    const op = (await operacoesPendentes()).find((o) => o.chave === chave)!;

    const auto = await decidirOperacao(op.id, 'teste.gate:ana', 'approved', 'eu mesma');
    expect(auto.ok).toBe(false);
    expect(auto.ok === false && auto.erro).toMatch(/não pode aprová-la/);

    expect((await decidirOperacao(op.id, 'teste.gate:vitor', 'approved', 'revisei o plano da ana')).ok).toBe(true);
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
