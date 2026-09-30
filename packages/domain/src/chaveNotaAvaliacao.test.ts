import { describe, expect, it } from 'vitest';
import { chaveNaturalNotaAvaliacao } from './provaXml';

/**
 * A CHAVE DO TERCEIRO CAMINHO DE ESCRITA.
 *
 * ─── UM `?? ''` PIOR QUE O `?? ''` ─────────────────────────────────────────
 *
 * Os dois caminhos anteriores degradavam a chave com string vazia. Este
 * degradava com a string **`"undefined"`**, e isso é pior.
 *
 * A causa: `rmAssessmentTargets` monta a chave a partir de `readView`, cujo
 * tipo é `DataServerRow = Record<string, string>`. Sem
 * `noUncheckedIndexedAccess` — que este projeto não liga —, o TypeScript
 * promete `string` até para chave inexistente. Em runtime,
 * `String(row.CODETAPA)` de um campo ausente devolve `"undefined"`.
 *
 * Por que é pior que `''`:
 *   - não casa com nada, igual ao vazio;
 *   - MAS não parece errado. Num log, `1|undefined|1|N|1714|RA` tem cara de
 *     chave válida, e qualquer guarda de "está vazio?" a deixa passar.
 *
 * ─── POR QUE LANÇA, EM VEZ DE ENTRAR EM SOMBRA ─────────────────────────────
 *
 * Os outros dois ganharam flag e período de sombra porque o gatilho deles é
 * real e recorrente: a Sentença SQL mora no RM e some a cada cópia de base.
 * Aqui não há Sentença — o schema do DataServer é do produto TOTVS.
 *
 * E foi medido em 30/09/2026: 245 linhas de `SProvas` e 3.507 de `SNotas`,
 * **zero** componentes de chave ausentes ou vazios. Sombra existe para reunir
 * evidência de que a regra nova não quebra nada; aqui a evidência já está
 * reunida, e seriam sete observações para confirmar um zero já medido.
 *
 * `chaveCourse` faz exatamente isto desde antes, com 13 testes. Seguir um
 * padrão que já existe vale mais que inventar um terceiro.
 */

const completa = {
  codColigada: '1',
  codProva: '7',
  codEtapa: '1',
  idTurmaDisc: '1714',
  ra: '2023100234',
};

describe('o formato, congelado', () => {
  /**
   * A ordem é a do `xs:unique` do XSD — CODCOLIGADA, CODPROVA, CODETAPA,
   * TIPOETAPA, IDTURMADISC, RA. Trocá-la faria toda nota parecer nova e
   * `NADA_A_FAZER` virar reescrita perpétua.
   */
  it('é [codColigada|codProva|codEtapa|N|idTurmaDisc|ra]', () => {
    expect(chaveNaturalNotaAvaliacao(completa)).toBe('1|7|1|N|1714|2023100234');
  });

  it('cada componente participa da identidade', () => {
    for (const k of ['codColigada', 'codProva', 'codEtapa', 'idTurmaDisc', 'ra'] as const) {
      const outra = { ...completa, [k]: '999' };
      expect(chaveNaturalNotaAvaliacao(outra), k).not.toBe(chaveNaturalNotaAvaliacao(completa));
    }
  });
});

describe('recusa componente que não dá chave', () => {
  /**
   * O caso central: `"undefined"` é o que `String(row.X)` produz quando o
   * campo some do `readView`. Tratá-lo como valor é o defeito.
   */
  it('a string "undefined" é RECUSADA, não aceita como valor', () => {
    expect(() => chaveNaturalNotaAvaliacao({ ...completa, codEtapa: 'undefined' })).toThrow(
      /codEtapa/,
    );
  });

  it('string vazia é recusada', () => {
    expect(() => chaveNaturalNotaAvaliacao({ ...completa, codProva: '' })).toThrow(/codProva/);
  });

  it('só espaço é recusado', () => {
    expect(() => chaveNaturalNotaAvaliacao({ ...completa, ra: '   ' })).toThrow(/ra/);
  });

  it('undefined de verdade é recusado', () => {
    expect(() =>
      chaveNaturalNotaAvaliacao({ ...completa, idTurmaDisc: undefined as unknown as string }),
    ).toThrow(/idTurmaDisc/);
  });

  it('null é recusado', () => {
    expect(() =>
      chaveNaturalNotaAvaliacao({ ...completa, codColigada: null as unknown as string }),
    ).toThrow(/codColigada/);
  });

  describe('cada componente é verificado, não só o primeiro', () => {
    for (const k of ['codColigada', 'codProva', 'codEtapa', 'idTurmaDisc', 'ra'] as const) {
      it(k, () => {
        expect(() => chaveNaturalNotaAvaliacao({ ...completa, [k]: '' })).toThrow(
          new RegExp(k),
        );
      });
    }
  });
});

describe('a mensagem serve para quem vai consertar', () => {
  it('nomeia o componente que faltou', () => {
    try {
      chaveNaturalNotaAvaliacao({ ...completa, codEtapa: '' });
      expect.unreachable('deveria ter lançado');
    } catch (e) {
      expect((e as Error).message).toContain('codEtapa');
    }
  });

  it('mostra o objeto inteiro, para o contexto não se perder', () => {
    try {
      chaveNaturalNotaAvaliacao({ ...completa, codEtapa: '' });
      expect.unreachable('deveria ter lançado');
    } catch (e) {
      expect((e as Error).message).toContain('1714');
    }
  });

  it('explica a CONSEQUÊNCIA, não só o sintoma', () => {
    // Quem lê isto às 3h precisa saber por que importa, não só o que quebrou.
    try {
      chaveNaturalNotaAvaliacao({ ...completa, ra: '' });
      expect.unreachable('deveria ter lançado');
    } catch (e) {
      expect((e as Error).message).toContain('ESCREVER_NOVO');
    }
  });
});

describe('valores legítimos não são confundidos com ausência', () => {
  /**
   * Código de etapa ou prova `'0'` é valor legítimo no RM, e a guarda não pode
   * confundi-lo com ausência.
   *
   * Nota de precisão, porque errei isto ao escrever o teste: `'0'` como
   * STRING é truthy — só o número `0` é falsy. Uma guarda com `!v` aqui não
   * recusaria `'0'`; ela deixaria passar `'   '`, que foi o que a mutação
   * mostrou. O teste continua valendo como trava contra alguém coagir para
   * número no futuro, mas o perigo real do `!v` é o espaço em branco, coberto
   * pelo teste "só espaço é recusado".
   */
  it("'0' é valor, não ausência", () => {
    expect(() => chaveNaturalNotaAvaliacao({ ...completa, codEtapa: '0' })).not.toThrow();
    expect(chaveNaturalNotaAvaliacao({ ...completa, codEtapa: '0' })).toContain('|0|');
  });

  it("'undefined' como SUBSTRING de um valor real não é recusado", () => {
    // Só o valor exatamente igual a "undefined" é ausência; um RA que por
    // acaso contenha essas letras é valor.
    expect(() =>
      chaveNaturalNotaAvaliacao({ ...completa, ra: 'undefined123' }),
    ).not.toThrow();
  });
});
