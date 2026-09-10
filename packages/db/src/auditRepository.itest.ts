import { afterAll, describe, expect, it } from 'vitest';
import { registrarEvento, ultimosEventos } from './auditRepository';
import { pgPool } from './pool';

/**
 * A trilha de auditoria, contra Postgres DE VERDADE.
 *
 * ─── O QUE SÓ O BANCO PODE PROVAR ───────────────────────────────────────────
 *
 * Que a tabela é append-only DE FATO. A migration 006 declarou isso em
 * comentário — "sem UPDATE e sem DELETE por contrato" — e contrato em comentário
 * é intenção. A migration 017 pôs triggers, e a única forma de verificar um
 * trigger é tentar o comando e receber o erro.
 *
 * ─── ESTA SUÍTE NÃO LIMPA O QUE ESCREVE ─────────────────────────────────────
 *
 * Não pode: o DELETE é justamente o que está sendo impedido. Por isso nenhuma
 * asserção aqui é sobre CONTAGEM ABSOLUTA — todas se ancoram num
 * `correlacao_id` único do próprio caso. Teste que afirma "a tabela tem 3
 * linhas" quebraria na segunda execução, e pior, convidaria alguém a "consertar"
 * desligando o trigger.
 */

const marca = (): string => `teste.audit.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;

afterAll(async () => {
  await pgPool.end();
});

describe('registrarEvento', () => {
  it('grava e devolve na leitura, com antes e depois', async () => {
    const correlacao = marca();
    await registrarEvento(pgPool, {
      ator: 'system/cli',
      acao: 'teste.audit.gravou',
      entidade: 'flow_schedule',
      entidadeId: 'teste.audit.fluxo',
      antes: { cron: '0 3 * * *', ativo: false },
      depois: { cron: '0 4 * * *', ativo: true },
      motivo: 'verificando a trilha',
      correlacaoId: correlacao,
      resultado: 'ok',
    });

    const { rows } = await pgPool.query<{ antes: unknown; depois: unknown; motivo: string }>(
      'select antes, depois, motivo from audit_event where correlacao_id = $1', [correlacao],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].antes).toEqual({ cron: '0 3 * * *', ativo: false });
    expect(rows[0].depois).toEqual({ cron: '0 4 * * *', ativo: true });
    expect(rows[0].motivo).toBe('verificando a trilha');
  });

  it('LANÇA quando não consegue gravar — ao contrário do resto do rastro', async () => {
    // Inversão deliberada: `job_run`, heartbeat e alerta nunca lançam, porque
    // observabilidade não pode derrubar a execução. Aqui a auditoria roda DENTRO
    // da transação da mudança, e uma mudança que não pôde ser registrada é uma
    // mudança que ninguém vai conseguir explicar depois. Melhor não ter
    // acontecido.
    const acaoLonga = 'x'.repeat(3);
    await expect(
      registrarEvento(pgPool, { ator: 'system/cli', acao: acaoLonga, antes: { ciclico: BigInt(1) } as never }),
    ).rejects.toThrow();
  });

  it('resolve `quem` a partir do ator user:<uuid>', async () => {
    // UUID na tela não é resposta. O JOIN com user_identity é o que transforma
    // `user:8f2a…` em um e-mail que alguém reconhece.
    const { rows } = await pgPool.query<{ id: string }>(
      `INSERT INTO user_identity (provider, subject, email)
       VALUES ('cli', 'teste.audit:quem', 'quem@teste.local')
       ON CONFLICT (provider, subject) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
    );
    const correlacao = marca();
    await registrarEvento(pgPool, {
      ator: `user:${rows[0].id}`, acao: 'teste.audit.com-identidade', correlacaoId: correlacao,
    });

    const eventos = await ultimosEventos(200);
    const meu = eventos.find((e) => e.correlacaoId === correlacao);
    expect(meu?.quem).toBe('quem@teste.local');
  });
});

describe('append-only (migration 017)', () => {
  it('recusa UPDATE', async () => {
    const correlacao = marca();
    await registrarEvento(pgPool, { ator: 'system/cli', acao: 'teste.audit.imutavel', correlacaoId: correlacao });

    await expect(
      pgPool.query('update audit_event set motivo = $1 where correlacao_id = $2', ['reescrito', correlacao]),
    ).rejects.toThrow(/append-only/);
  });

  it('recusa DELETE', async () => {
    const correlacao = marca();
    await registrarEvento(pgPool, { ator: 'system/cli', acao: 'teste.audit.imutavel', correlacaoId: correlacao });

    await expect(
      pgPool.query('delete from audit_event where correlacao_id = $1', [correlacao]),
    ).rejects.toThrow(/append-only/);
  });

  it('recusa TRUNCATE — o comando que destruiria a trilha inteira', async () => {
    // TRUNCATE não dispara trigger de LINHA e não aparece em lugar nenhum. É o
    // comando que apaga tudo sem rastro, e por isso tem trigger próprio.
    await expect(pgPool.query('truncate audit_event')).rejects.toThrow(/append-only/);
  });
});
