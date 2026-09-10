import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  alterarAgenda, comTravaDeReconciliacao, lerAgenda, listarAgenda,
  marcarAplicada, semear, tenantIdDaAgenda,
} from './scheduleRepository';
import { registrarEvento } from './auditRepository';
import { pgPool } from './pool';

/**
 * A agenda no banco, contra Postgres DE VERDADE.
 *
 * O que se verifica aqui É comportamento do Postgres, e mockar testaria o mock:
 * o `ON CONFLICT DO NOTHING` que faz a semente valer uma vez só, o CHECK que
 * recusa cron com número errado de campos, o `FOR UPDATE` que serializa duas
 * mudanças na mesma linha, e o advisory lock que impede duas reconciliações
 * simultâneas.
 *
 * O último é o mais difícil de acreditar sem banco: `pg_try_advisory_lock` é por
 * SESSÃO, então provar que a segunda chamada desiste exige duas conexões reais.
 */

/** Prefixo próprio: a suíte limpa o que ela criou, nunca por categoria. */
const FLUXO = 'teste.agenda.fluxo';
const FLUXO_2 = 'teste.agenda.fluxo2';
const TZ = 'America/Sao_Paulo';

const limpar = async (): Promise<void> => {
  await pgPool.query("delete from flow_schedule where flow_key like 'teste.agenda.%'");
};

beforeEach(limpar);
afterAll(async () => {
  await limpar();
  await pgPool.end();
});

describe('semear', () => {
  it('insere na primeira vez e NÃO sobrescreve na segunda', async () => {
    // É a precedência de uma via inteira, em uma cláusula. Se a semente
    // sobrescrevesse, o próximo deploy desfaria em silêncio o que a tela mudou —
    // com a tela mostrando o valor novo por cima.
    expect(await semear(FLUXO, '0 3 * * *', true, TZ)).toBe(true);
    expect(await semear(FLUXO, '0 9 * * *', false, TZ)).toBe(false);

    const linha = await lerAgenda(FLUXO);
    expect(linha?.cron).toBe('0 3 * * *');
    expect(linha?.ativo).toBe(true);
  });

  it('nasce com revisão 1 e sem aplicação registrada', async () => {
    await semear(FLUXO, '0 3 * * *', false, TZ);
    const linha = await lerAgenda(FLUXO);
    expect(linha?.revisao).toBe(1);
    expect(linha?.revisaoAplicada).toBeNull();
    expect(linha?.aplicadaEm).toBeNull();
  });

  it('o banco recusa cron que não tenha 5 campos', async () => {
    // A validação completa (intervalo mínimo, prévia) é em config/cron.ts, mas o
    // grosseiro é recusado embaixo de qualquer caminho de escrita — inclusive um
    // INSERT feito à mão no psql.
    await expect(semear(FLUXO, '*/30 0 3 * * *', false, TZ)).rejects.toThrow();
  });
});

describe('alterarAgenda', () => {
  it('sobe a revisão e devolve antes e depois', async () => {
    await semear(FLUXO, '0 3 * * *', true, TZ);
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      const r = await alterarAgenda(client, { flowKey: FLUXO, cron: '0 4 * * *', atualizadoPor: await identidade() });
      await client.query('COMMIT');

      expect(r?.antes.cron).toBe('0 3 * * *');
      expect(r?.depois.cron).toBe('0 4 * * *');
      expect(r?.depois.revisao).toBe(2);
    } finally {
      client.release();
    }
  });

  it('NÃO sobe a revisão quando nada muda', async () => {
    // Sem isto, o poll do worker regravaria o mesmo scheduler a cada volta:
    // barulho no log e escrita no Redis sem motivo.
    await semear(FLUXO, '0 3 * * *', true, TZ);
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      const r = await alterarAgenda(client, { flowKey: FLUXO, cron: '0 3 * * *', ativo: true, atualizadoPor: await identidade() });
      await client.query('COMMIT');
      expect(r?.depois.revisao).toBe(1);
    } finally {
      client.release();
    }
  });

  it('devolve null quando o fluxo não tem linha', async () => {
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      expect(await alterarAgenda(client, { flowKey: 'teste.agenda.inexistente', ativo: true, atualizadoPor: await identidade() })).toBeNull();
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('rollback da transação desfaz a mudança E a auditoria juntas', async () => {
    // A propriedade que justifica a auditoria ser transacional: mudança sem
    // trilha (ou trilha sem mudança) deixaria a `audit_event` num estado em que
    // ninguém confia.
    await semear(FLUXO, '0 3 * * *', true, TZ);
    const correlacao = `teste.agenda.rollback.${Date.now()}`;
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      await alterarAgenda(client, { flowKey: FLUXO, cron: '0 5 * * *', atualizadoPor: await identidade() });
      await registrarEvento(client, {
        ator: 'system/cli', acao: 'teste.agenda.alterada', correlacaoId: correlacao,
      });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    expect((await lerAgenda(FLUXO))?.cron).toBe('0 3 * * *');
    const { rowCount } = await pgPool.query(
      'select 1 from audit_event where correlacao_id = $1', [correlacao],
    );
    expect(rowCount).toBe(0);
  });
});

describe('marcarAplicada', () => {
  it('registra a revisão aplicada e limpa o erro anterior', async () => {
    await semear(FLUXO, '0 3 * * *', true, TZ);

    await marcarAplicada(FLUXO, 1, 'Redis fora do ar');
    expect((await lerAgenda(FLUXO))?.erroAoAplicar).toBe('Redis fora do ar');

    // `null` limpa: a tela não deve mostrar para sempre uma falha já resolvida.
    await marcarAplicada(FLUXO, 1, null);
    const depois = await lerAgenda(FLUXO);
    expect(depois?.erroAoAplicar).toBeNull();
    expect(depois?.revisaoAplicada).toBe(1);
    expect(depois?.aplicadaEm).not.toBeNull();
  });

  it('nunca lança, mesmo com fluxo inexistente', async () => {
    // Registro de estado observado não pode derrubar a reconciliação: o próximo
    // poll tenta de novo. Mesma regra do job_run.
    await expect(marcarAplicada('teste.agenda.inexistente', 9, null)).resolves.toBeUndefined();
  });
});

describe('comTravaDeReconciliacao', () => {
  it('a segunda chamada simultânea desiste com "ocupado"', async () => {
    // Duas reconciliações intercaladas poderiam deixar o Redis com uma revisão
    // ANTIGA depois de uma nova ter sido aplicada — e a tela mostraria
    // "aplicado" num horário que não é o que vai disparar.
    const resultado = await comTravaDeReconciliacao(async () => {
      // Chamada de dentro: outra conexão do pool, outra sessão do Postgres.
      return comTravaDeReconciliacao(async () => 'entrou');
    });
    expect(resultado).toBe('ocupado');
  });

  it('libera a trava no fim, mesmo quando a função lança', async () => {
    // Lock de SESSÃO num pool que reusa conexões: esquecer o unlock travaria
    // toda reconciliação seguinte até o processo morrer.
    await expect(
      comTravaDeReconciliacao(async () => { throw new Error('falha proposital'); }),
    ).rejects.toThrow('falha proposital');

    expect(await comTravaDeReconciliacao(async () => 'livre')).toBe('livre');
  });
});

describe('listarAgenda', () => {
  it('devolve só os fluxos deste tenant, ordenados', async () => {
    await semear(FLUXO_2, '0 9 * * *', false, TZ);
    await semear(FLUXO, '0 3 * * *', true, TZ);
    const chaves = (await listarAgenda()).filter((a) => a.flowKey.startsWith('teste.agenda.')).map((a) => a.flowKey);
    expect(chaves).toEqual([FLUXO, FLUXO_2]);
  });
});

/** Identidade descartável para preencher `atualizado_por`. */
async function identidade(): Promise<string> {
  const { rows } = await pgPool.query<{ id: string }>(
    `INSERT INTO user_identity (provider, subject, nome)
     VALUES ('cli', 'teste.agenda:quem', 'Suíte da agenda')
     ON CONFLICT (provider, subject) DO UPDATE SET subject = EXCLUDED.subject
     RETURNING id`,
  );
  // `tenantIdDaAgenda` é exercitada de lado aqui: sem tenant resolvido nada
  // acima funcionaria, e o erro seria confuso.
  await tenantIdDaAgenda();
  return rows[0].id;
}
