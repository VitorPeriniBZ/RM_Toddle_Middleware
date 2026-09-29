import { describe, expect, it } from 'vitest';
import type { ConsultaRow } from '@rm-toddle/integrations';
import { colunasDaChaveAusentes } from './rmAttendanceSource';

/**
 * COLUNA AUSENTE DO RESULT SET × VALOR VAZIO NUMA LINHA.
 *
 * O `?? ''` tratava as duas do mesmo jeito, e elas pedem reações opostas:
 *
 *   coluna ausente   a Sentença mudou. Vale para TODAS as linhas. É drift, e o
 *                    run inteiro está comprometido.
 *   valor vazio      aquele registro está incompleto. Vale para uma linha.
 *
 * A distinção é observável e barata: olha-se as CHAVES do objeto, não os
 * valores. Uma coluna que existe e vem nula continua existindo.
 *
 * Confundi-las foi o defeito; separá-las é o conserto. Estes testes travam a
 * separação.
 */

const linha = (m: Record<string, string> = {}): ConsultaRow =>
  ({
    RA: '2023100234',
    DATA: '2026-09-01',
    ID_TURMADISC: '1714',
    ID_HORARIO_TURMA: '48211',
    PRESENCA: 'A',
    CODFILIAL: '2',
    ...m,
  }) as ConsultaRow;

describe('result set completo', () => {
  it('nada ausente', () => {
    expect(colunasDaChaveAusentes([linha()])).toEqual([]);
  });

  /**
   * A razão de ser do `pick`: a Sentença pode declarar `IDTURMADISC` ou
   * `ID_TURMADISC`, e as duas são a mesma coluna. Acusar drift por causa do
   * underscore seria alarme falso na primeira semana.
   */
  it('aceita as variantes de nome que o `pick` aceita', () => {
    const r = colunasDaChaveAusentes([
      { RA: '1', DATA: '2026-09-01', IDTURMADISC: '1714', IDHORARIOTURMA: '48211' } as ConsultaRow,
    ]);
    expect(r).toEqual([]);
  });

  it('é indiferente a maiúsculas e minúsculas, como o `pick`', () => {
    const r = colunasDaChaveAusentes([
      { ra: '1', data: '2026-09-01', id_turmadisc: '1714', id_horario_turma: '48211' } as ConsultaRow,
    ]);
    expect(r).toEqual([]);
  });
});

describe('a distinção que o `?? \'\'` apagava', () => {
  /**
   * ─── O CASO CENTRAL ───────────────────────────────────────────────────────
   *
   * A coluna EXISTE e o valor vem vazio. Isso NÃO é drift de Sentença: é uma
   * linha incompleta. Acusar drift aqui abortaria o run inteiro por causa de um
   * registro — e no modo estrito isso é uma sincronização de frequência que
   * para de rodar até alguém intervir.
   */
  it('valor VAZIO com a coluna presente NÃO é coluna ausente', () => {
    expect(colunasDaChaveAusentes([linha({ ID_TURMADISC: '' })])).toEqual([]);
  });

  it('valor nulo com a coluna presente NÃO é coluna ausente', () => {
    const r = colunasDaChaveAusentes([
      { ...linha(), ID_TURMADISC: null } as unknown as ConsultaRow,
    ]);
    expect(r).toEqual([]);
  });

  it('a coluna SUMINDO do objeto é o drift de verdade', () => {
    const { ID_TURMADISC: _, ...semColuna } = linha() as Record<string, unknown>;
    expect(colunasDaChaveAusentes([semColuna as ConsultaRow])).toEqual(['ID_TURMADISC']);
  });
});

describe('quais colunas importam', () => {
  /**
   * Só as que compõem a chave natural. Uma `JUSTIFICATIVA` que suma empobrece o
   * relatório; uma `ID_TURMADISC` que suma desliga a proteção contra
   * sobrescrever lançamento de professor. Tratar as duas como drift crítico
   * faria o alerta perder o significado.
   */
  it('coluna fora da chave sumindo NÃO é acusada', () => {
    const { JUSTIFICATIVA: _j, PRESENCA: _p, ...sem } = {
      ...linha(),
      JUSTIFICATIVA: 'x',
    } as Record<string, unknown>;
    expect(colunasDaChaveAusentes([sem as ConsultaRow])).toEqual([]);
  });

  const daChave: Array<[string, string]> = [
    ['RA', 'RA'],
    ['DATA', 'DATA'],
    ['ID_TURMADISC', 'ID_TURMADISC'],
    ['ID_HORARIO_TURMA', 'ID_HORARIO_TURMA'],
  ];
  for (const [coluna, esperado] of daChave) {
    it(`${coluna} sumindo é acusada`, () => {
      const copia = { ...linha() } as Record<string, unknown>;
      delete copia[coluna];
      expect(colunasDaChaveAusentes([copia as ConsultaRow])).toContain(esperado);
    });
  }

  it('duas sumindo: as duas são nomeadas', () => {
    const copia = { ...linha() } as Record<string, unknown>;
    delete copia.ID_TURMADISC;
    delete copia.ID_HORARIO_TURMA;
    expect(colunasDaChaveAusentes([copia as ConsultaRow])).toEqual([
      'ID_TURMADISC',
      'ID_HORARIO_TURMA',
    ]);
  });
});

describe('result set vazio', () => {
  /**
   * Sem linha nenhuma não há result set para inspecionar, e "janela sem aula" é
   * estado legítimo — fim de semana, feriado, recesso. Acusar drift aqui seria
   * alerta toda segunda-feira de manhã sobre o domingo.
   */
  it('nenhuma linha: nada a acusar', () => {
    expect(colunasDaChaveAusentes([])).toEqual([]);
  });
});
