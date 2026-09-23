import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { hashValor } from '@rm-toddle/domain';
import {
  abrirRun, acumularLote, avaliarDesvio, fecharRunPorChave, ultimaContagemEmEscopo,
} from './runRepository';
import { pgPool } from './pool';

/**
 * Registro de execução, contra Postgres DE VERDADE.
 *
 * A parte arriscada é a aritmética jsonb DENTRO do `UPDATE`:
 * `(resultado->>'x')::int + $n` lê o valor anterior da própria linha, para que
 * dois lotes concorrentes não se sobrescrevam. Erro ali é contador
 * silenciosamente errado — o tipo de bug que ninguém percebe.
 */

const TIPO = 'teste.run';
beforeEach(async () => { await pgPool.query('delete from job_run where tipo = $1', [TIPO]); });
afterAll(async () => {
  await pgPool.query('delete from job_run where tipo = $1', [TIPO]);
  await pgPool.end();
});

const abrir = (chave: string, lotes: number, emEscopo = 255) =>
  abrirRun({
    tipo: TIPO, chave, configVersion: 'v1',
    payload: { lotesEsperados: lotes },
    resultadoInicial: { emEscopo, lotesConcluidos: 0 },
  });

describe('acumulação por lote', () => {
  it('só o ÚLTIMO lote fecha o run, e os contadores somam', async () => {
    await abrir('r1', 3);
    expect(await acumularLote('r1', { created: 1, updated: 49, inalterados: 0, unarchived: 0, failed: 0 })).toBeNull();
    expect(await acumularLote('r1', { created: 2, updated: 48, inalterados: 0, unarchived: 1, failed: 0 })).toBeNull();
    const r = await acumularLote('r1', { created: 0, updated: 50, inalterados: 0, unarchived: 0, failed: 0 });
    expect(r?.completo).toBe(true);
    expect(r?.estado).toBe('succeeded');
    expect(r?.resultado).toMatchObject({ created: 3, updated: 147, unarchived: 1 });
  });

  it('preserva emEscopo através do merge jsonb', async () => {
    // Se o `||` sobrescrevesse em vez de mesclar, a guarda de desvio do run
    // seguinte perderia a referência.
    await abrir('r2', 1);
    const r = await acumularLote('r2', { created: 0, updated: 1, inalterados: 0, unarchived: 0, failed: 0 });
    expect(r?.resultado.emEscopo).toBe(255);
  });

  it('lote com falha marca o run como failed', async () => {
    await abrir('r3', 1, 10);
    const r = await acumularLote('r3', { created: 0, updated: 9, inalterados: 0, unarchived: 0, failed: 1 });
    expect(r?.estado).toBe('failed');
  });

  it('acumular em run já fechado não reabre nem soma', async () => {
    await abrir('r4', 1);
    await acumularLote('r4', { created: 1, updated: 0, inalterados: 0, unarchived: 0, failed: 0 });
    expect(await acumularLote('r4', { created: 99, updated: 99, inalterados: 0, unarchived: 0, failed: 0 })).toBeNull();
  });
});

describe('baseline da guarda de desvio', () => {
  it('lê o último run SUCCEEDED e ignora o failed', async () => {
    await abrir('b1', 1, 255);
    await acumularLote('b1', { created: 0, updated: 255, inalterados: 0, unarchived: 0, failed: 0 });
    await abrir('b2', 1, 10);
    await fecharRunPorChave('b2', 'failed', { emEscopo: 10, motivo: 'abortado' });
    expect(await ultimaContagemEmEscopo(TIPO)).toBe(255);
  });

  it('devolve null sem histórico', async () => {
    expect(await ultimaContagemEmEscopo('tipo.que.nunca.existiu')).toBeNull();
  });
});

describe('idempotência da chave', () => {
  it('reabrir a mesma chave não duplica linha', async () => {
    await abrir('i1', 3);
    await abrir('i1', 3);
    const { rows } = await pgPool.query<{ c: number }>(
      'select count(*)::int c from job_run where chave = $1', ['i1'],
    );
    expect(rows[0].c).toBe(1);
  });
});

describe('a guarda de desvio (pura, mas fica junto do que a alimenta)', () => {
  it.each([
    ['desvio pequeno passa', 255, 257, false],
    ['desvio grande aborta', 255, 300, true],
    ['queda a zero aborta', 255, 0, true],
  ])('%s', (_, anterior, atual, aborta) => {
    expect(avaliarDesvio(anterior as number, atual as number).aborta).toBe(aborta);
  });

  it.each([
    ['sem histórico não opina', null],
    ['anterior zero não opina', 0],
  ])('%s', (_, anterior) => {
    expect(avaliarDesvio(anterior as number | null, 255).aborta).toBe(false);
  });
});

describe('hashValor é o contrato compartilhado', () => {
  it('mesma normalização que a proveniência usa', () => {
    expect(hashValor(' a  b ')).toBe(hashValor('a b'));
  });
});

/**
 * A duração é `updated_at - created_at`, e nem todo `abrirRun` acontece no
 * começo do trabalho.
 *
 * Nos fluxos de nota ele é chamado DEPOIS de ler o Toddle e o RM, e no caminho
 * de saída antecipada (`nada-a-escrever`) no FIM, só para registrar que a
 * passada existiu. Sem o instante de início, a linha das 08:15 de 14/09/2026
 * marcou 9 ms para uma passada que a fila cronometrou em 31 s.
 */
describe('a duração mede o trabalho, não o registro', () => {
  it('o run nasce com o instante de início que recebeu', async () => {
    const inicio = new Date(Date.now() - 31_000);
    await abrirRun({
      tipo: TIPO, chave: 'd1', configVersion: 'v1', payload: {}, inicio,
    });
    await fecharRunPorChave('d1', 'succeeded', {});
    const { rows } = await pgPool.query<{ ms: number }>(
      `select round(extract(epoch from (updated_at - created_at)) * 1000)::int ms
         from job_run where chave = $1`, ['d1'],
    );
    // 31s de trabalho, e não os milissegundos entre abrir e fechar a linha.
    expect(rows[0].ms).toBeGreaterThanOrEqual(30_000);
  });

  it('sem o instante, `created_at` é agora — o comportamento de sempre', async () => {
    await abrirRun({ tipo: TIPO, chave: 'd2', configVersion: 'v1', payload: {} });
    const { rows } = await pgPool.query<{ ms: number }>(
      `select round(extract(epoch from (now() - created_at)) * 1000)::int ms
         from job_run where chave = $1`, ['d2'],
    );
    expect(rows[0].ms).toBeLessThan(5_000);
  });
});
