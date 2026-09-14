import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  RecusaDeAcesso,
  concederPapel,
  concederPapelAExistente,
  listarAcessos,
  listarIdentidadesSemPapel,
  papeisDoUsuario,
  quantosAdministram,
  revogarPapel,
} from './accessRepository';
import { pgPool } from './pool';

/**
 * Acesso, contra Postgres DE VERDADE.
 *
 * O que se testa aqui não é SQL bonito: é a guarda que impede o tenant de ficar
 * sem ninguém capaz de conceder acesso, e o fato de a trilha de auditoria viver
 * ou morrer junto com a mudança. As duas são propriedades do BANCO — uma é o
 * `DELETE` competindo com uma contagem, a outra é a transação. Um mock testaria
 * o mock.
 */

const SUJEITO = (n: string) => `teste-acesso:${n}`;

async function limpar(): Promise<void> {
  await pgPool.query(
    `DELETE FROM membership WHERE user_identity_id IN
       (SELECT id FROM user_identity WHERE subject LIKE 'teste-acesso:%')`,
  );
  /*
   * `audit_event` NÃO é limpa, e a tentativa de limpá-la é que ensinou por quê:
   * a migration 017 recusa DELETE na trilha, no banco, com uma mensagem
   * explicando que reescrevê-la destrói a única evidência que existe. O teste
   * estava errado, não a tabela.
   *
   * Não faz falta: `user_identity` é apagada e recriada a cada rodada, então o
   * `entidade_id` de agora nunca colide com o de antes, e as contagens abaixo
   * ficam isoladas sozinhas.
   */
  await pgPool.query("DELETE FROM user_identity WHERE subject LIKE 'teste-acesso:%'");
}

beforeEach(limpar);
afterAll(async () => {
  await limpar();
  await pgPool.end();
});

/** Cria a identidade JÁ com um papel, como o bootstrap por CLI faz. */
const semear = (n: string, papel: Parameters<typeof concederPapel>[1]) =>
  concederPapel({ subject: SUJEITO(n), email: `${n}@teste.local`, provider: 'cli' }, papel);

describe('a fila de espera', () => {
  it('quem autenticou e não tem papel aparece — é daí que a tela concede', async () => {
    // `concederPapel` cria a identidade; remover o papel deixa exatamente o
    // estado de quem tentou entrar e levou 403.
    const { userIdentityId } = await semear('espera', 'viewer');
    await revogarPapel({ userIdentityId, papel: 'viewer', ator: 'system/cli' });

    const fila = await listarIdentidadesSemPapel();
    expect(fila.map((p) => p.subject)).toContain(SUJEITO('espera'));

    // E some da fila assim que ganha qualquer papel.
    await concederPapelAExistente({ userIdentityId, papel: 'viewer', ator: 'system/cli' });
    const depois = await listarIdentidadesSemPapel();
    expect(depois.map((p) => p.subject)).not.toContain(SUJEITO('espera'));
  });

  it('quem tem papel NÃO aparece na fila', async () => {
    await semear('comacesso', 'approver');
    const fila = await listarIdentidadesSemPapel();
    expect(fila.map((p) => p.subject)).not.toContain(SUJEITO('comacesso'));
  });
});

describe('conceder', () => {
  it('exige identidade existente — a tela não inventa um `sub`', async () => {
    await expect(
      concederPapelAExistente({
        userIdentityId: '00000000-0000-0000-0000-000000000000',
        papel: 'viewer',
        ator: 'system/cli',
      }),
    ).rejects.toBeInstanceOf(RecusaDeAcesso);
  });

  it('é idempotente, e conceder o que já existe NÃO vira evento', async () => {
    const { userIdentityId } = await semear('idem', 'viewer');

    const primeira = await concederPapelAExistente({ userIdentityId, papel: 'approver', ator: 'system/cli' });
    const segunda = await concederPapelAExistente({ userIdentityId, papel: 'approver', ator: 'system/cli' });
    expect(primeira.jaTinha).toBe(false);
    expect(segunda.jaTinha).toBe(true);

    // Uma linha por MUDANÇA, não por clique: registrar a segunda produziria
    // trilha de cliques em vez de trilha de decisões.
    const { rows } = await pgPool.query<{ n: string }>(
      `SELECT count(*)::text n FROM audit_event
        WHERE acao = 'acesso.concedido' AND entidade_id = $1`,
      [userIdentityId],
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it('grava quem concedeu, a quem e qual papel', async () => {
    const { userIdentityId } = await semear('trilha', 'viewer');
    await concederPapelAExistente({
      userIdentityId, papel: 'integration_operator', ator: 'user:alguem', motivo: 'entrou na equipe',
    });

    const { rows } = await pgPool.query<{ ator: string; depois: Record<string, unknown>; motivo: string }>(
      `SELECT ator, depois, motivo FROM audit_event
        WHERE acao = 'acesso.concedido' AND entidade_id = $1`,
      [userIdentityId],
    );
    expect(rows[0].ator).toBe('user:alguem');
    expect(rows[0].depois).toMatchObject({ papel: 'integration_operator', subject: SUJEITO('trilha') });
    expect(rows[0].motivo).toBe('entrou na equipe');
  });
});

describe('a guarda de tranca', () => {
  it('recusa remover o ÚLTIMO tenant_admin', async () => {
    const { userIdentityId } = await semear('unico', 'tenant_admin');
    const antes = await quantosAdministram();
    expect(antes).toBeGreaterThanOrEqual(1);

    if (antes === 1) {
      await expect(
        revogarPapel({ userIdentityId, papel: 'tenant_admin', ator: 'system/cli' }),
      ).rejects.toBeInstanceOf(RecusaDeAcesso);
      // E não removeu: a transação inteira voltou.
      expect(await papeisDoUsuario(userIdentityId)).toContain('tenant_admin');
    }
  });

  it('permite remover quando há OUTRO — é o tenant que não pode ficar órfão, não a pessoa', async () => {
    const a = await semear('admin-a', 'tenant_admin');
    const b = await semear('admin-b', 'tenant_admin');
    expect(await quantosAdministram()).toBeGreaterThanOrEqual(2);

    await revogarPapel({ userIdentityId: a.userIdentityId, papel: 'tenant_admin', ator: 'system/cli' });
    expect(await papeisDoUsuario(a.userIdentityId)).not.toContain('tenant_admin');
    expect(await papeisDoUsuario(b.userIdentityId)).toContain('tenant_admin');
  });

  it('a guarda vale só para tenant_admin — outros papéis saem livremente', async () => {
    const { userIdentityId } = await semear('operador', 'integration_operator');
    const r = await revogarPapel({ userIdentityId, papel: 'integration_operator', ator: 'system/cli' });
    expect(r.naoTinha).toBe(false);
    expect(await papeisDoUsuario(userIdentityId)).toEqual([]);
  });
});

describe('revogar', () => {
  it('revogar o que não existe não é erro, e não vira evento', async () => {
    const { userIdentityId } = await semear('nada', 'viewer');
    const r = await revogarPapel({ userIdentityId, papel: 'approver', ator: 'system/cli' });
    expect(r.naoTinha).toBe(true);

    const { rows } = await pgPool.query<{ n: string }>(
      `SELECT count(*)::text n FROM audit_event
        WHERE acao = 'acesso.revogado' AND entidade_id = $1`,
      [userIdentityId],
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it('o papel some da listagem depois de revogado', async () => {
    const { userIdentityId } = await semear('somem', 'viewer');
    await concederPapelAExistente({ userIdentityId, papel: 'approver', ator: 'system/cli' });
    await revogarPapel({ userIdentityId, papel: 'viewer', ator: 'system/cli' });

    const linha = (await listarAcessos()).find((p) => p.userIdentityId === userIdentityId);
    expect(linha?.papeis).toEqual(['approver']);
  });
});
