import { describe, expect, it } from 'vitest';
import { montaLotesNotas, notaParaRm, TIPOETAPA_NOTA } from './notaXml';
import type { ProjetadoNota } from './gradeProjection';

/**
 * O XML da nota. Três coisas aqui são medidas, não escolhidas, e cada uma delas
 * quebraria a escrita em silêncio (o RM responde HTTP 200 mesmo recusando):
 *
 *   1. o dataset é `EduNotaEtapa` e NÃO tem namespace — o da frequência tem
 *   2. `TIPOETAPA` é sempre 'N': 'F' gravaria um total de faltas no lugar da nota
 *   3. `NOTAFALTA` vai com PONTO decimal, nunca vírgula
 */

const pr = (ra: string, nota: string, over: Partial<ProjetadoNota['linha']> = {}): ProjetadoNota => {
  const linha: ProjetadoNota['linha'] = {
    codColigada: '1',
    ra,
    idTurmaDisc: '1266',
    codEtapa: '1',
    tipoEtapa: TIPOETAPA_NOTA,
    nota,
    ...over,
  };
  return {
    linha,
    chaveRm: `${linha.codColigada}|${linha.codEtapa}|N|${linha.idTurmaDisc}|${linha.ra}`,
    origemId: `origem-${ra}`,
    origem: {
      studentId: `t-${ra}`,
      gradingPeriodId: 'gp-1',
      teacherCourseId: 'tc-1',
      subjectId: null,
      courseIds: ['curso-1'],
      criterio: 'FINAL_SCORE',
      valorCru: nota,
      valorNumerico: Number(nota),
      origemId: `origem-${ra}`,
    },
  };
};

describe('notaParaRm', () => {
  it('usa ponto decimal e não deixa casa desnecessária', () => {
    expect(notaParaRm(7)).toBe('7');
    expect(notaParaRm(6.5)).toBe('6.5');
    expect(notaParaRm(0)).toBe('0');
    expect(notaParaRm(6.1234)).toBe('6.1234');
  });

  it('arredonda na quarta casa, que é o que o RM guarda', () => {
    expect(notaParaRm(6.123456)).toBe('6.1235');
  });

  it('recusa valor não finito em vez de emitir "NaN" no XML', () => {
    expect(() => notaParaRm(Number.NaN)).toThrow();
    expect(() => notaParaRm(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe('montaLotesNotas', () => {
  it('o dataset é EduNotaEtapa e SEM namespace', () => {
    const [lote] = montaLotesNotas([pr('RA1', '6')]);
    expect(lote.xml).toContain('<EduNotaEtapa>');
    // O erro que este teste existe para pegar: copiar o cabeçalho da frequência.
    expect(lote.xml).not.toContain('xmlns');
    expect(lote.xml).not.toContain('tempuri');
  });

  it('não emite PARAMS nem tabela de alunos — o EduNotaEtapa não os tem', () => {
    const [lote] = montaLotesNotas([pr('RA1', '6')]);
    expect(lote.xml).not.toContain('<PARAMS>');
    expect(lote.xml).not.toContain('AlunosFreq');
  });

  it('TIPOETAPA é sempre N', () => {
    const [lote] = montaLotesNotas([pr('RA1', '6'), pr('RA2', '7')]);
    expect(lote.xml.match(/<TIPOETAPA>N<\/TIPOETAPA>/g)).toHaveLength(2);
    expect(lote.xml).not.toContain('<TIPOETAPA>F</TIPOETAPA>');
  });

  it('agrupa por (IDTURMADISC, CODETAPA) — um dataset por recorte de etapa', () => {
    const lotes = montaLotesNotas([
      pr('RA1', '6'),
      pr('RA2', '7'),
      pr('RA3', '5', { codEtapa: '2' }),
      pr('RA4', '4', { idTurmaDisc: '1267' }),
    ]);
    expect(lotes.map((l) => `${l.idTurmaDisc}|${l.codEtapa}`)).toEqual(['1266|1', '1266|2', '1267|1']);
    expect(lotes[0].linhas).toHaveLength(2);
  });

  it('deduplica pela chave natural: o RM vem com EnforceConstraints=False', () => {
    // O XSD DECLARA xs:unique, mas o dataset desliga a checagem. Duas linhas com
    // a mesma chave passariam, e o comportamento seria indefinido.
    const [lote] = montaLotesNotas([pr('RA1', '6'), pr('RA1', '6')]);
    expect(lote.linhas).toHaveLength(1);
    expect(lote.xml.match(/<SNotaEtapa>/g)).toHaveLength(1);
  });

  it('ordena por RA, para o XML de dois runs iguais ser igual', () => {
    const [lote] = montaLotesNotas([pr('RA9', '6'), pr('RA1', '7')]);
    expect(lote.xml.indexOf('RA1')).toBeLessThan(lote.xml.indexOf('RA9'));
  });

  it('omite AULASDADAS por default e ecoa quando recebe a função', () => {
    const [sem] = montaLotesNotas([pr('RA1', '6')]);
    expect(sem.xml).not.toContain('AULASDADAS');
    expect(sem.aulasDadas).toBeNull();

    const [com] = montaLotesNotas([pr('RA1', '6')], () => '40');
    expect(com.xml).toContain('<AULASDADAS>40</AULASDADAS>');
    expect(com.aulasDadas).toBe('40');
  });

  it('escapa o que precisa ser escapado', () => {
    const [lote] = montaLotesNotas([pr('RA&<1>', '6')]);
    expect(lote.xml).toContain('RA&amp;&lt;1&gt;');
  });

  it('lote vazio devolve lista vazia, não um dataset sem linhas', () => {
    expect(montaLotesNotas([])).toEqual([]);
  });
});
