import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { alterarDetector, lerDetector, listarDetectores, registrarVolta, semearDetector } from './continuoRepository';
import { pgPool } from './pool';

/**
 * Os detectores no banco, contra Postgres DE VERDADE.
 *
 * O que importa aqui é do Postgres: a semente que vale uma vez só e nasce
 * DESLIGADA, os CHECK que recusam intervalo fora de 30 s–1 h, e o `COALESCE`
 * do `registrarVolta` que preserva a memória quando a volta falha.
 */

const CHAVE = 'teste.continuo.det';
const PADRAO = { intervaloSegundos: 60, horaInicio: 6, horaFim: 22 };

const limpar = async (): Promise<void> => {
  await pgPool.query("delete from fluxo_continuo where chave like 'teste.continuo.%'");
};

beforeEach(limpar);
afterAll(async () => {
  await limpar();
  await pgPool.end();
});

async function identidade(): Promise<string> {
  const { rows } = await pgPool.query<{ id: string }>(
    `INSERT INTO user_identity (provider, subject, nome)
     VALUES ('cli', 'teste.continuo:quem', 'Suíte dos detectores')
     ON CONFLICT (provider, subject) DO UPDATE SET subject = EXCLUDED.subject
     RETURNING id`,
  );
  return rows[0].id;
}

/** A versão que uma volta leria ao começar. */
async function versao(): Promise<string> {
  return (await lerDetector(CHAVE))!.atualizadoEm;
}

async function emTransacao<T>(fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const c = await pgPool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

describe('semearDetector', () => {
  it('nasce DESLIGADO, e a segunda semente não sobrescreve', async () => {
    expect(await semearDetector(CHAVE, PADRAO)).toBe(true);
    expect(await semearDetector(CHAVE, { ...PADRAO, intervaloSegundos: 300 })).toBe(false);
    const d = await lerDetector(CHAVE);
    expect(d?.ativo).toBe(false);
    expect(d?.intervaloSegundos).toBe(60);
    expect(d?.estado).toEqual({});
  });
});

describe('alterarDetector', () => {
  it('liga e devolve antes e depois', async () => {
    await semearDetector(CHAVE, PADRAO);
    const quem = await identidade();
    const r = await emTransacao((c) => alterarDetector(c, { chave: CHAVE, ativo: true, atualizadoPor: quem }));
    expect(r?.antes.ativo).toBe(false);
    expect(r?.depois.ativo).toBe(true);
  });

  it('o banco recusa intervalo abaixo de 30 s', async () => {
    await semearDetector(CHAVE, PADRAO);
    const quem = await identidade();
    await expect(
      emTransacao((c) => alterarDetector(c, { chave: CHAVE, intervaloSegundos: 5, atualizadoPor: quem })),
    ).rejects.toThrow();
  });

  it('desligar limpa a pausa e as falhas — quem religa espera um detector novo', async () => {
    await semearDetector(CHAVE, PADRAO);
    const quem = await identidade();
    await emTransacao((c) => alterarDetector(c, { chave: CHAVE, ativo: true, atualizadoPor: quem }));
    await registrarVolta(CHAVE, await versao(), {
      sondou: false, mudou: false, erro: 'recusou credencial', falhasSeguidas: 3,
      pausadoAte: new Date(Date.now() + 3_600_000), contadores: {},
    });
    await emTransacao((c) => alterarDetector(c, { chave: CHAVE, ativo: false, atualizadoPor: quem }));
    const d = await lerDetector(CHAVE);
    expect(d?.pausadoAte).toBeNull();
    expect(d?.falhasSeguidas).toBe(0);
  });

  it('linha inexistente devolve null', async () => {
    const quem = await identidade();
    expect(await emTransacao((c) => alterarDetector(c, { chave: 'teste.continuo.nao', ativo: true, atualizadoPor: quem }))).toBeNull();
  });
});

describe('registrarVolta', () => {
  it('volta bem-sucedida grava memória, carimbos e contadores', async () => {
    await semearDetector(CHAVE, PADRAO);
    await registrarVolta(CHAVE, await versao(), {
      estado: { desde: 'x' }, sondou: true, mudou: true,
      disparo: { desfechos: { 'term-grades.sync': 'enfileirado' }, resumo: '2 notas novas em 1 turma' },
      erro: null, falhasSeguidas: 0, pausadoAte: null,
      contadores: { dia: '2026-10-09', sondagens: 1, mudancas: 1, disparos: 1 },
    });
    const d = await lerDetector(CHAVE);
    expect(d?.estado).toEqual({ desde: 'x' });
    expect(d?.ultimaSondagemEm).not.toBeNull();
    expect(d?.ultimaMudancaEm).not.toBeNull();
    expect(d?.ultimoDisparo?.resumo).toBe('2 notas novas em 1 turma');
    expect(d?.contadores.disparos).toBe(1);
  });

  it('volta que FALHOU preserva a memória anterior e grava o erro', async () => {
    // Avançar a marca numa volta que falhou perderia o que ela não leu.
    await semearDetector(CHAVE, PADRAO);
    await registrarVolta(CHAVE, await versao(), {
      estado: { desde: 'antes' }, sondou: true, mudou: false, erro: null,
      falhasSeguidas: 0, pausadoAte: null, contadores: {},
    });
    await registrarVolta(CHAVE, await versao(), {
      sondou: false, mudou: false, erro: 'RM fora do ar', falhasSeguidas: 1, pausadoAte: null, contadores: {},
    });
    const d = await lerDetector(CHAVE);
    expect(d?.estado).toEqual({ desde: 'antes' });
    expect(d?.ultimoErro).toBe('RM fora do ar');
    expect(d?.falhasSeguidas).toBe(1);
  });

  it('só uma volta que SONDOU limpa o erro', async () => {
    await semearDetector(CHAVE, PADRAO);
    await registrarVolta(CHAVE, await versao(), {
      sondou: false, mudou: false, erro: 'falhou', falhasSeguidas: 1, pausadoAte: null, contadores: {},
    });
    await registrarVolta(CHAVE, await versao(), {
      sondou: true, mudou: false, erro: null, falhasSeguidas: 0, pausadoAte: null, contadores: {},
    });
    expect((await lerDetector(CHAVE))?.ultimoErro).toBeNull();
  });

  it('a listagem não carrega a memória — a tela recarrega a cada 10 s', async () => {
    await semearDetector(CHAVE, PADRAO);
    const d = (await listarDetectores()).find((x) => x.chave === CHAVE);
    expect(d).toBeDefined();
    expect('estado' in (d as object)).toBe(false);
  });
});

describe('a volta não passa por cima da tela', () => {
  it('se alguém desligou durante a volta, a gravação da volta é descartada', async () => {
    await semearDetector(CHAVE, PADRAO);
    const quem = await identidade();
    await emTransacao((c) => alterarDetector(c, { chave: CHAVE, ativo: true, atualizadoPor: quem }));
    const lida = await versao(); // a volta começa e lê a linha

    // ... e no meio dela, alguém desliga pela tela.
    await new Promise((r) => setTimeout(r, 5));
    await emTransacao((c) => alterarDetector(c, { chave: CHAVE, ativo: false, atualizadoPor: quem }));

    await registrarVolta(CHAVE, lida, {
      sondou: false, mudou: false, erro: 'recusou', falhasSeguidas: 1,
      pausadoAte: new Date(Date.now() + 3_600_000), contadores: {},
    });
    const d = await lerDetector(CHAVE);
    expect(d?.pausadoAte).toBeNull();
    expect(d?.ultimoErro).toBeNull();
  });

  it('LIGAR zera a memória — a primeira volta depois é linha de base', async () => {
    await semearDetector(CHAVE, PADRAO);
    await registrarVolta(CHAVE, await versao(), {
      estado: { desde: 'semanas atrás' }, sondou: true, mudou: false, erro: null,
      falhasSeguidas: 0, pausadoAte: null, contadores: {},
    });
    const quem = await identidade();
    await emTransacao((c) => alterarDetector(c, { chave: CHAVE, ativo: true, atualizadoPor: quem }));
    expect((await lerDetector(CHAVE))?.estado).toEqual({});
  });

  it('retomar limpa a pausa sem desligar', async () => {
    await semearDetector(CHAVE, PADRAO);
    const quem = await identidade();
    await emTransacao((c) => alterarDetector(c, { chave: CHAVE, ativo: true, atualizadoPor: quem }));
    await registrarVolta(CHAVE, await versao(), {
      sondou: false, mudou: false, erro: 'x', falhasSeguidas: 2,
      pausadoAte: new Date(Date.now() + 3_600_000), contadores: {},
    });
    const r = await emTransacao((c) => alterarDetector(c, { chave: CHAVE, retomar: true, atualizadoPor: quem }));
    expect(r?.depois.ativo).toBe(true);
    expect(r?.depois.pausadoAte).toBeNull();
    expect(r?.depois.falhasSeguidas).toBe(0);
  });
});
