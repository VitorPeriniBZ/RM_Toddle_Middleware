import { describe, expect, it } from 'vitest';
import {
  chaveNaturalNotaAvaliacao,
  decimalParaRm,
  montaLotesNotasAvaliacao,
  montaXmlProva,
  type NotaParaEscrever,
} from './provaXml';

/**
 * O XML das avaliações. Cada teste aqui existe por causa de uma medição, e o
 * primeiro grupo por causa de uma ESCRITA RECUSADA em produção-sandbox.
 */

describe('decimalParaRm — o separador é VÍRGULA, e isso foi medido do jeito difícil', () => {
  it('usa vírgula, não ponto', () => {
    // Enviar "6.25" numa prova de VALOR=10 fez o RM recusar o dataset inteiro:
    // "A nota informada excede o valor máximo permitido para esta prova, que é
    // de 10,0000 pontos". Ele leu 6.25 como 625 — ponto é separador de MILHAR
    // no locale pt-BR, e o dataset declara UseCurrentLocale="true".
    expect(decimalParaRm(6.25)).toBe('6,25');
    expect(decimalParaRm(8.5)).toBe('8,5');
  });

  it('inteiro sai sem separador nenhum', () => {
    expect(decimalParaRm(7)).toBe('7');
    expect(decimalParaRm(10)).toBe('10');
    expect(decimalParaRm(0)).toBe('0');
  });

  it('arredonda na quarta casa, que é o que o RM guarda', () => {
    expect(decimalParaRm(6.123456)).toBe('6,1235');
  });

  it('recusa valor não finito em vez de emitir "NaN" no XML', () => {
    expect(() => decimalParaRm(Number.NaN)).toThrow();
    expect(() => decimalParaRm(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe('montaXmlProva', () => {
  const base = {
    codColigada: '1',
    idTurmaDisc: '1266',
    codEtapa: '2',
    codProva: '6',
    descricao: 'Prova 1 - Relevo brasileiro',
    valor: 10,
  };

  it('o dataset é EduProvas e NÃO tem namespace', () => {
    const xml = montaXmlProva(base);
    expect(xml).toContain('<EduProvas>');
    expect(xml).not.toContain('xmlns');
    expect(xml).not.toContain('tempuri');
  });

  it('TIPOETAPA é sempre N — F criaria avaliação de FALTA', () => {
    expect(montaXmlProva(base)).toContain('<TIPOETAPA>N</TIPOETAPA>');
  });

  it('trunca a descrição em 100, que é o maxLength do XSD', () => {
    const xml = montaXmlProva({ ...base, descricao: 'x'.repeat(150) });
    const m = /<DESCRICAO>(.*)<\/DESCRICAO>/.exec(xml);
    expect(m?.[1]).toHaveLength(100);
  });

  it('escapa o que precisa', () => {
    expect(montaXmlProva({ ...base, descricao: 'Prova <A> & "B"' })).toContain(
      'Prova &lt;A&gt; &amp; &quot;B&quot;',
    );
  });
});

const nota = (ra: string, valor: number, over: Partial<NotaParaEscrever> = {}): NotaParaEscrever => ({
  codColigada: '1',
  codProva: '6',
  codEtapa: '2',
  idTurmaDisc: '1266',
  ra,
  nota: valor,
  ...over,
});

describe('montaLotesNotasAvaliacao', () => {
  it('o dataset é EduNotas, sem namespace, com a nota em vírgula', () => {
    const [l] = montaLotesNotasAvaliacao([nota('RA1', 6.25)]);
    expect(l.xml).toContain('<EduNotas>');
    expect(l.xml).not.toContain('xmlns');
    expect(l.xml).toContain('<NOTA>6,25</NOTA>');
  });

  it('agrupa por (turma-disciplina, etapa, prova)', () => {
    const lotes = montaLotesNotasAvaliacao([
      nota('RA1', 7),
      nota('RA2', 8),
      nota('RA3', 9, { codProva: '7' }),
      nota('RA4', 5, { idTurmaDisc: '1267' }),
    ]);
    expect(lotes.map((l) => `${l.idTurmaDisc}|${l.codEtapa}|${l.codProva}`)).toEqual([
      '1266|2|6',
      '1266|2|7',
      '1267|2|6',
    ]);
    expect(lotes[0].linhas).toHaveLength(2);
  });

  it('deduplica por RA: EnforceConstraints vem False e o RM não rejeita repetida', () => {
    const [l] = montaLotesNotasAvaliacao([nota('RA1', 7), nota('RA1', 9)]);
    expect(l.linhas).toHaveLength(1);
    expect(l.xml.match(/<SNotas>/g)).toHaveLength(1);
  });

  it('ordena por RA, para dois runs iguais produzirem o mesmo XML', () => {
    const [l] = montaLotesNotasAvaliacao([nota('RA9', 7), nota('RA1', 8)]);
    expect(l.xml.indexOf('RA1')).toBeLessThan(l.xml.indexOf('RA9'));
  });

  it('lote vazio devolve lista vazia', () => {
    expect(montaLotesNotasAvaliacao([])).toEqual([]);
  });
});

describe('chaveNaturalNotaAvaliacao', () => {
  it('segue a ordem do xs:unique: coligada, prova, etapa, tipo, turma-disc, RA', () => {
    expect(
      chaveNaturalNotaAvaliacao({
        codColigada: '1',
        codProva: '6',
        codEtapa: '2',
        idTurmaDisc: '1266',
        ra: '202600109',
      }),
    ).toBe('1|6|2|N|1266|202600109');
  });
});
