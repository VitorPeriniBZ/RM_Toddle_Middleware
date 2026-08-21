import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { hashValor } from '@rm-toddle/domain';
import {
  listarPendencias,
  registrarPendencia,
  resolverPendencia,
  resumoPendencias,
} from './pendencyRepository';
import { pgPool } from './pool';

/**
 * A fila de pendências, contra Postgres DE VERDADE.
 *
 * ─── O QUE SÓ O BANCO RESPONDE ──────────────────────────────────────────────
 *
 * A regra de reabertura vive num `ON CONFLICT ... DO UPDATE` com quatro `CASE`
 * comparando `hash_desejado`. E é ela que decide se a fila serve para algo:
 *
 *   - reabrir toda passada tornaria "resolver" inútil (o cron roda 4x ao dia, a
 *     pendência voltaria em 6h e a fila viraria ruído permanente);
 *   - nunca reabrir faria uma decisão antiga valer para um valor novo, que
 *     ninguém analisou.
 */

const K = '1|5791|1240|202600009|2026-03-02';
const base = {
  entidade: 'FREQUENCIA' as const,
  chaveNatural: K,
  veredito: 'CONFLITO_HUMANO' as const,
  porque: 'o RM tem valor diferente e a autoria não é da integração',
  valorNoRm: 'P',
  origemId: 'tod-1',
};

beforeEach(async () => {
  await pgPool.query('delete from write_pendency');
});
afterAll(async () => {
  await pgPool.query('delete from write_pendency');
  await pgPool.end();
});

describe('primeira detecção', () => {
  it('nasce aberta, com os dois lados do conflito', async () => {
    const aberta = await registrarPendencia({ ...base, valorDesejado: 'A', hashDesejado: hashValor('A') });
    expect(aberta).toBe(true);
    const [p] = await listarPendencias({ estado: 'aberta' });
    expect(p.vezesVista).toBe(1);
    expect(p.valorDesejado).toBe('A');
    expect(p.valorNoRm).toBe('P');
  });
});

describe('redetecção do MESMO conflito', () => {
  it('não duplica linha e avança vezesVista', async () => {
    for (let i = 0; i < 3; i += 1) {
      await registrarPendencia({ ...base, valorDesejado: 'A', hashDesejado: hashValor('A') });
    }
    const { rows } = await pgPool.query<{ c: number }>('select count(*)::int c from write_pendency');
    expect(rows[0].c).toBe(1);
    expect((await listarPendencias())[0].vezesVista).toBe(3);
  });
});

describe('resolver', () => {
  it('grava a resolução e sai da contagem de abertas', async () => {
    await registrarPendencia({ ...base, valorDesejado: 'A', hashDesejado: hashValor('A') });
    const [p] = await listarPendencias();
    expect(await resolverPendencia(p.id, 'vitor', 'corrigi no Toddle')).toBe(true);
    expect((await resumoPendencias()).abertas).toBe(0);
    expect((await listarPendencias({ estado: 'resolvida' }))[0].resolucao).toBe('corrigi no Toddle');
  });

  it('resolver duas vezes não faz efeito', async () => {
    await registrarPendencia({ ...base, valorDesejado: 'A', hashDesejado: hashValor('A') });
    const [p] = await listarPendencias();
    await resolverPendencia(p.id, 'vitor', 'primeira');
    expect(await resolverPendencia(p.id, 'vitor', 'segunda')).toBe(false);
  });
});

describe('a regra de reabertura', () => {
  const resolvida = async (): Promise<void> => {
    await registrarPendencia({ ...base, valorDesejado: 'A', hashDesejado: hashValor('A') });
    const [p] = await listarPendencias();
    await resolverPendencia(p.id, 'vitor', 'corrigi no Toddle');
  };

  it('MESMO valor NÃO reabre, mas avança vezesVista', async () => {
    await resolvida();
    const aberta = await registrarPendencia({ ...base, valorDesejado: 'A', hashDesejado: hashValor('A') });
    expect(aberta).toBe(false);
    const [p] = await listarPendencias();
    expect(p.estado).toBe('resolvida');
    expect(p.vezesVista).toBe(2);
    expect(p.resolucao).toBe('corrigi no Toddle');
  });

  it('valor DIFERENTE reabre e LIMPA a resolução', async () => {
    await resolvida();
    const aberta = await registrarPendencia({ ...base, valorDesejado: 'FJ', hashDesejado: hashValor('FJ') });
    expect(aberta).toBe(true);
    const [p] = await listarPendencias();
    expect(p.estado).toBe('aberta');
    // A decisão anterior foi sobre outro valor; mantê-la faria parecer que
    // alguém já analisou este conflito.
    expect(p.resolucao).toBeUndefined();
    expect(p.valorDesejado).toBe('FJ');
  });

  it('espaço em branco não conta como valor novo', async () => {
    await resolvida();
    const aberta = await registrarPendencia({ ...base, valorDesejado: ' A ', hashDesejado: hashValor(' A ') });
    expect(aberta).toBe(false);
  });
});

describe('campo NULL e campo preenchido convivem', () => {
  it('a mesma chave com e sem campo são duas pendências', async () => {
    const k = '1|1240|281980';
    await registrarPendencia({
      entidade: 'PLANO_AULA', chaveNatural: k, campo: 'CONTEUDOEFETIVO',
      veredito: 'EDITADO_POR_FORA', porque: 'editaram depois de nós',
      valorDesejado: 'Frações', hashDesejado: hashValor('Frações'),
    });
    await registrarPendencia({
      entidade: 'PLANO_AULA', chaveNatural: k,
      veredito: 'REMOCAO_PEDE_HUMANO', porque: 'saiu do Toddle',
      hashDesejado: hashValor(null),
    });
    expect((await listarPendencias({ entidade: 'PLANO_AULA' })).length).toBe(2);
  });
});

describe('resumo e filtros', () => {
  it('agrupa por veredito e entidade, e datas a idade', async () => {
    await registrarPendencia({ ...base, valorDesejado: 'A', hashDesejado: hashValor('A') });
    await registrarPendencia({
      entidade: 'NOTA', chaveNatural: 'n1', veredito: 'EDITADO_POR_FORA',
      porque: 'x', hashDesejado: hashValor('7'),
    });
    const r = await resumoPendencias();
    expect(r.abertas).toBe(2);
    expect(r.porEntidade).toEqual({ FREQUENCIA: 1, NOTA: 1 });
    expect(r.maisAntigaDias).toBe(0);
    expect((await listarPendencias({ veredito: 'EDITADO_POR_FORA' })).length).toBe(1);
  });
});

describe('o banco protege a integridade', () => {
  it.each([
    ["'resolvida' sem responsável", "'FREQUENCIA', 'k-solta', 'CONFLITO_HUMANO', 'x', 'h', 'resolvida'"],
    ['veredito inventado', "'FREQUENCIA', 'k2', 'VEREDITO_INVENTADO', 'x', 'h', 'aberta'"],
  ])('recusa %s', async (_, valores) => {
    await expect(
      pgPool.query(
        `insert into write_pendency
           (tenant_id, entidade, chave_natural, veredito, porque, hash_desejado, estado)
         select t.id, ${valores} from tenant t limit 1`,
      ),
    ).rejects.toThrow();
  });
});
