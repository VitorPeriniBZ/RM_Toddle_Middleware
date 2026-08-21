import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashValor } from '@rm-toddle/domain';
import { abrirRun } from './runRepository';
import {
  carregarProveniencia,
  chaveDoMapa,
  contarProveniencia,
  escritasDoRun,
  registrarEscrita,
} from './provenanceRepository';
import { pgPool } from './pool';

/**
 * Proveniência contra Postgres DE VERDADE.
 *
 * O que só o banco responde: o índice único usa `coalesce(campo, '')` porque em
 * Postgres NULL **não participa** de UNIQUE — sem isso, duas linhas com campo
 * nulo para a mesma chave conviveriam e "isto é nosso?" teria duas respostas.
 * Não se confere lendo SQL.
 */

const K = '1|5791|1240|202600009|2026-03-02';
let runId: string | null = null;

const limpar = async (): Promise<void> => {
  await pgPool.query('delete from rm_write_provenance');
  await pgPool.query("delete from operation where tipo = 'teste.prov'");
};

beforeAll(async () => {
  await limpar();
  runId = await abrirRun({ tipo: 'teste.prov', chave: 'prov-1', configVersion: 'v', payload: {} });
});
afterAll(async () => {
  await limpar();
  await pgPool.end();
});

describe('granularidade de LINHA (frequência, nota)', () => {
  it('grava e carrega com campo nulo', async () => {
    await registrarEscrita({
      entidade: 'FREQUENCIA',
      chaveNatural: K,
      payloadHash: hashValor('A'),
      runId: runId,
    });
    const m = await carregarProveniencia('FREQUENCIA', [K]);
    expect(m.get(chaveDoMapa(K))?.payloadHash).toBe(hashValor('A'));
  });

  it('reescrever a mesma chave atualiza no lugar, sem duplicar', async () => {
    await registrarEscrita({
      entidade: 'FREQUENCIA',
      chaveNatural: K,
      payloadHash: hashValor('P'),
      runId: runId,
    });
    const { rows } = await pgPool.query<{ c: number }>(
      'select count(*)::int c from rm_write_provenance where chave_natural = $1',
      [K],
    );
    expect(rows[0].c).toBe(1);
    const m = await carregarProveniencia('FREQUENCIA', [K]);
    expect(m.get(chaveDoMapa(K))?.payloadHash).toBe(hashValor('P'));
  });
});

describe('granularidade de CAMPO (plano de aula)', () => {
  // As 22.367 linhas de SPLANOAULA são pré-criadas pela grade: nenhuma é nossa,
  // e a regra por linha bloquearia 100% das escritas. Lá o dono é o CAMPO.
  const K2 = '1|1240|281980';

  it('dois campos da mesma chave convivem', async () => {
    await registrarEscrita({
      entidade: 'PLANO_AULA',
      chaveNatural: K2,
      campo: 'CONTEUDOEFETIVO',
      payloadHash: hashValor('Frações'),
      runId: runId,
    });
    await registrarEscrita({
      entidade: 'PLANO_AULA',
      chaveNatural: K2,
      campo: 'LICAOCASA',
      payloadHash: hashValor('pág. 42'),
      runId: runId,
    });
    const m = await carregarProveniencia('PLANO_AULA', [K2]);
    expect(m.size).toBe(2);
    expect(m.get(chaveDoMapa(K2, 'CONTEUDOEFETIVO'))?.payloadHash).toBe(hashValor('Frações'));
    expect(m.get(chaveDoMapa(K2, 'LICAOCASA'))?.payloadHash).toBe(hashValor('pág. 42'));
  });

  it('entidades diferentes não se misturam', async () => {
    expect((await carregarProveniencia('FREQUENCIA', [K2])).size).toBe(0);
  });
});

describe('lote', () => {
  it('resolve 200 chaves numa consulta e devolve só as conhecidas', async () => {
    // Uma consulta por chave transformaria um lote de 2.000 em 2.000
    // round-trips contra um SOAP lento.
    const chaves = Array.from({ length: 200 }, (_, i) => `1|h${i}|td|ra|2026-03-02`);
    for (const c of chaves.slice(0, 50)) {
      await registrarEscrita({
        entidade: 'FREQUENCIA',
        chaveNatural: c,
        payloadHash: hashValor('A'),
        runId: runId,
      });
    }
    expect((await carregarProveniencia('FREQUENCIA', chaves)).size).toBe(50);
  });

  it('lista vazia não vai ao banco', async () => {
    expect((await carregarProveniencia('FREQUENCIA', [])).size).toBe(0);
  });
});

describe('lista de reversão', () => {
  it('escritasDoRun devolve tudo que o run escreveu', async () => {
    // Existe porque "quem restaura a base do RM e em quanto tempo" costuma ser
    // "suporte TOTVS, 48h".
    expect((await escritasDoRun(runId!)).length).toBe(53);
  });

  it('contarProveniencia agrupa por entidade', async () => {
    expect(await contarProveniencia()).toEqual({ FREQUENCIA: 51, PLANO_AULA: 2 });
  });
});

describe('o banco protege a integridade', () => {
  it('recusa entidade fora do CHECK', async () => {
    await expect(
      registrarEscrita({
        entidade: 'INVENTADA' as never,
        chaveNatural: 'x',
        payloadHash: 'h',
      }),
    ).rejects.toThrow();
  });
});
