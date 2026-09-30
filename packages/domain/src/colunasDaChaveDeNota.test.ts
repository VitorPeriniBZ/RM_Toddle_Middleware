import { describe, expect, it } from 'vitest';
import type { ConsultaRow } from '@rm-toddle/integrations';
import { colunasAusentesNoResultSet, explicarColunasAusentes } from './colunasDaChave';
import { colunasDaChaveAusentes } from './rmAttendanceSource';
import { colunasDaChaveDeNotaAusentes } from './rmGradeSource';

/**
 * A MESMA REGRA, DUAS FONTES, UMA IMPLEMENTAÇÃO.
 *
 * O P0-6 escreveu a detecção de coluna ausente dentro de `rmAttendanceSource`.
 * O P1-A precisou dela para `rmGradeSource`, e copiar seria repetir o defeito
 * que este projeto mais persegue — duas cópias de uma regra sutil, que
 * divergem no dia em que alguém melhora uma delas. Foi por isso que
 * `chaveNaturalDeFalta` chama `chaveNaturalRm` em vez de reimplementá-la, e
 * há um teste estrutural só para garantir que continue assim.
 *
 * Aqui o compartilhamento é testável por COMPORTAMENTO: as duas fontes têm de
 * reagir igual ao mesmo result set degradado, cada uma com a sua lista de
 * colunas. É o que este arquivo verifica.
 */

const linhaDeNota = (m: Record<string, unknown> = {}): ConsultaRow =>
  ({
    RA: '2023100234',
    ID_TURMADISC: '1714',
    CODETAPA: '1',
    CODCOLIGADA: '1',
    TIPOETAPA: 'N',
    NOTA: '7,5',
    CODFILIAL: '2',
    ...m,
  }) as ConsultaRow;

describe('a chave da NOTA e as colunas que a compõem', () => {
  it('result set completo: nada ausente', () => {
    expect(colunasDaChaveDeNotaAusentes([linhaDeNota()])).toEqual([]);
  });

  /**
   * `CODCOLIGADA` NÃO entra na lista, e isso é decisão, não esquecimento: o
   * leitor cai para `cfg.rm.escopo.coligada` quando ela falta, e esse default
   * é correto — é a mesma coligada que a Sentença consulta, porque vai como
   * parâmetro da consulta. Exigi-la produziria alarme sobre um caso já
   * resolvido.
   */
  it('CODCOLIGADA sumindo NÃO é acusada — o leitor tem default correto', () => {
    const { CODCOLIGADA: _, ...sem } = linhaDeNota() as Record<string, unknown>;
    expect(colunasDaChaveDeNotaAusentes([sem as ConsultaRow])).toEqual([]);
  });

  const daChave: Array<[string, string]> = [
    ['RA', 'RA'],
    ['ID_TURMADISC', 'ID_TURMADISC'],
    ['CODETAPA', 'CODETAPA'],
  ];
  for (const [coluna, esperado] of daChave) {
    it(`${coluna} sumindo é acusada`, () => {
      const copia = { ...linhaDeNota() } as Record<string, unknown>;
      delete copia[coluna];
      expect(colunasDaChaveDeNotaAusentes([copia as ConsultaRow])).toContain(esperado);
    });
  }

  it('aceita as variantes que o `pick` de notas aceita', () => {
    const r = colunasDaChaveDeNotaAusentes([
      { RA: '1', IDTURMADISC: '1714', COD_ETAPA: '1' } as ConsultaRow,
    ]);
    expect(r).toEqual([]);
  });

  /**
   * A distinção central, herdada do P0-6: coluna que existe e vem vazia é
   * problema de UMA linha (o leitor a descarta); coluna que sumiu do result
   * set é drift da Sentença e vale para todas.
   */
  it('CODETAPA presente e VAZIO não é coluna ausente', () => {
    expect(colunasDaChaveDeNotaAusentes([linhaDeNota({ CODETAPA: '' })])).toEqual([]);
  });

  it('CODETAPA presente e nulo não é coluna ausente', () => {
    expect(colunasDaChaveDeNotaAusentes([linhaDeNota({ CODETAPA: null })])).toEqual([]);
  });

  it('coluna fora da chave sumindo não é acusada', () => {
    const { NOTA: _, ...sem } = linhaDeNota() as Record<string, unknown>;
    expect(colunasDaChaveDeNotaAusentes([sem as ConsultaRow])).toEqual([]);
  });

  it('result set vazio: nada a acusar', () => {
    expect(colunasDaChaveDeNotaAusentes([])).toEqual([]);
  });
});

describe('as duas fontes usam a MESMA implementação', () => {
  /**
   * Teste de COMPORTAMENTO, não estrutural — a regra permanente manda tentar
   * o comportamento primeiro, e aqui ele denuncia: se alguém reimplementar uma
   * das duas, ela deixa de reagir igual ao mesmo result set degradado.
   *
   * O que se verifica é a propriedade comum, não a lista de colunas (que é
   * legitimamente diferente entre frequência e notas).
   */
  const propriedades: Array<[string, (rows: ConsultaRow[]) => string[]]> = [
    ['frequência', colunasDaChaveAusentes],
    ['notas', colunasDaChaveDeNotaAusentes],
  ];

  for (const [nome, detectar] of propriedades) {
    it(`${nome}: result set vazio nunca acusa`, () => {
      expect(detectar([])).toEqual([]);
    });

    it(`${nome}: valor vazio numa linha nunca é coluna ausente`, () => {
      // Todas as colunas presentes, todas vazias: existe schema, faltam dados.
      const vazias = Object.fromEntries(
        Object.keys(linhaDeNota()).map((k) => [k, '']),
      ) as ConsultaRow;
      expect(detectar([{ ...vazias, DATA: '', ID_HORARIO_TURMA: '' } as ConsultaRow])).toEqual([]);
    });

    it(`${nome}: a união das linhas vale, não a primeira`, () => {
      // O .NET omite o elemento quando o valor é DBNull, então a linha 0 pode
      // não ter uma coluna que as demais têm. Acusar por amostra de 1
      // abortaria o run em modo estrito por causa de um registro.
      const completa = { ...linhaDeNota(), DATA: '2026-09-01', ID_HORARIO_TURMA: '48211' };
      const semUma = { ...completa } as Record<string, unknown>;
      delete semUma.RA;
      expect(detectar([semUma as ConsultaRow, completa as ConsultaRow])).toEqual([]);
    });
  }
});

describe('a explicação é a mesma para as duas fontes', () => {
  /**
   * Quem lê o alerta de notas às 3h da manhã não deveria precisar aprender um
   * vocabulário diferente do que já leu no de frequência.
   */
  it('nomeia o fluxo, a Sentença e as colunas', () => {
    const t = explicarColunasAusentes({
      fluxo: 'notas',
      sentenca: 'TODDLE.NOTAS',
      ausentes: ['CODETAPA'],
    });
    expect(t).toContain('notas');
    expect(t).toContain('TODDLE.NOTAS');
    expect(t).toContain('CODETAPA');
  });

  it('diz o que fazer, não só o que quebrou', () => {
    const t = explicarColunasAusentes({ fluxo: 'x', sentenca: 'Y', ausentes: ['Z'] });
    expect(t).toContain('npm run canario');
  });

  it('nomeia a causa provável, que é a cópia de base', () => {
    const t = explicarColunasAusentes({ fluxo: 'x', sentenca: 'Y', ausentes: ['Z'] });
    expect(t).toContain('cópia de base');
  });
});

describe('o helper genérico', () => {
  it('lista vazia de exigidas nunca acusa', () => {
    expect(colunasAusentesNoResultSet([linhaDeNota()], [])).toEqual([]);
  });

  it('devolve o nome CANÔNICO — o primeiro da lista de variantes', () => {
    const r = colunasAusentesNoResultSet([{ X: '1' } as ConsultaRow], [
      ['ID_TURMADISC', 'IDTURMADISC'],
    ]);
    expect(r).toEqual(['ID_TURMADISC']);
  });

  it('é indiferente a maiúsculas e minúsculas', () => {
    expect(colunasAusentesNoResultSet([{ id_turmadisc: '1' } as ConsultaRow], [['ID_TURMADISC']])).toEqual(
      [],
    );
  });
});
