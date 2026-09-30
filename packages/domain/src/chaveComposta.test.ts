import { describe, expect, it } from 'vitest';
import { chaveComposta } from './chaveComposta';

/**
 * O CONSUMIDOR DO MISS É O ELO QUE NINGUÉM AUDITOU.
 *
 * ─── A LIÇÃO QUE ESTE ARQUIVO REGISTRA ─────────────────────────────────────
 *
 * Duas chaves inline, mesma classe de defeito — componente cru de
 * `Record<string, string>` interpolado em template literal, virando a palavra
 * `"undefined"` quando o campo some — e consequências OPOSTAS:
 *
 *   FALHA ABERTA   `provasPorEtapa.get(chave) ?? []` devolve lista vazia.
 *                  `proximoCodProva` volta 1, a guarda anti-duplicata por
 *                  descrição fica vazia, e o sistema CRIA uma avaliação que já
 *                  existe, com CODPROVA colidindo. No registro acadêmico.
 *
 *   FAIL-SAFE      `ctx.etapasRm.get(chave)` sem default. `gradeProjection`
 *                  recusa com ETAPA_NAO_GRAVAVEL e a nota não é escrita.
 *                  (Rede congelada em `gradeProjection.test.ts`: "etapasRm
 *                  vazio -> ETAPA_NAO_GRAVAVEL".)
 *
 * A diferença nunca esteve escrita em lugar nenhum. A segunda é fail-safe POR
 * ACIDENTE — propriedade que morre no dia em que um consumidor novo escrever
 * `?? algumPadrão`.
 *
 * Por isso a decisão sai do consumidor: chave incompleta não chega a existir.
 *
 * ─── E POR QUE NÃO `noUncheckedIndexedAccess` ──────────────────────────────
 *
 * Porque a flag não pegaria nenhum dos dois. `String(row.CODETAPA)` compila
 * sob ela (String aceita undefined), e interpolar em template literal também.
 * Medido: 253 erros com a flag ligada, e os dois defeitos reais deste item não
 * estão entre eles. A flag é higiene de tipos; o detector desta classe é a
 * regra de lint, e a guarda é este módulo.
 */

describe('monta a chave quando todos os componentes são valor', () => {
  it('junta na ordem das chaves do objeto, com barra vertical', () => {
    expect(chaveComposta('x', { a: '1714', b: '1' })).toBe('1714|1');
  });

  it('a ordem do objeto é a ordem da chave', () => {
    // Importa: o consumidor tem de montar na MESMA ordem, ou não casa.
    expect(chaveComposta('x', { a: '1', b: '2' })).not.toBe(
      chaveComposta('x', { b: '2', a: '1' }),
    );
  });

  it('aguenta um componente só', () => {
    expect(chaveComposta('x', { a: '7' })).toBe('7');
  });
});

describe('recusa o que não é valor', () => {
  /**
   * O caso central e o mais difícil de ver: `"undefined"` é o que
   * `String(undefined)` produz, e num log `1714|undefined` tem cara de chave
   * legítima. `''` ao menos parece errado.
   */
  it('a string "undefined" é recusada', () => {
    expect(() => chaveComposta('provasPorEtapa', { idTurmaDisc: '1714', codEtapa: 'undefined' }))
      .toThrow(/codEtapa/);
  });

  it('undefined de verdade é recusado', () => {
    expect(() => chaveComposta('x', { a: '1', b: undefined })).toThrow(/"b"/);
  });

  it('null é recusado', () => {
    expect(() => chaveComposta('x', { a: null })).toThrow(/"a"/);
  });

  it('string vazia é recusada', () => {
    expect(() => chaveComposta('x', { a: '' })).toThrow(/"a"/);
  });

  /**
   * `!v` deixaria passar `'   '`. O perigo real de uma guarda por falsy em
   * strings é o espaço em branco — `'0'` é truthy, só o NÚMERO zero é falsy.
   */
  it('só espaço em branco é recusado', () => {
    expect(() => chaveComposta('x', { a: '   ' })).toThrow(/"a"/);
  });

  it('verifica TODOS os componentes, não só o primeiro', () => {
    expect(() => chaveComposta('x', { a: '1', b: '2', c: '' })).toThrow(/"c"/);
  });
});

describe('valores legítimos não são confundidos com ausência', () => {
  it("'0' é valor — string não-vazia, e código legítimo no RM", () => {
    expect(chaveComposta('x', { a: '0', b: '1' })).toBe('0|1');
  });

  it("'undefined' como SUBSTRING é valor", () => {
    // Só o componente exatamente igual a "undefined" é ausência; um código que
    // por acaso contenha essas letras é dado.
    expect(chaveComposta('x', { a: 'undefined-2' })).toBe('undefined-2');
  });

  it('espaço INTERNO é preservado — o trim é só para decidir, não para alterar', () => {
    expect(chaveComposta('x', { a: 'A B' })).toBe('A B');
  });
});

describe('a mensagem serve para quem vai consertar', () => {
  it('nomeia o índice que recusou', () => {
    expect(() => chaveComposta('provasPorEtapa', { a: '' })).toThrow(/provasPorEtapa/);
  });

  it('nomeia o componente que faltou', () => {
    expect(() => chaveComposta('x', { idTurmaDisc: '1714', codEtapa: '' })).toThrow(/codEtapa/);
  });

  it('mostra o objeto inteiro, para o contexto não se perder', () => {
    expect(() => chaveComposta('x', { idTurmaDisc: '1714', codEtapa: '' })).toThrow(/1714/);
  });

  /**
   * A consequência varia conforme o consumidor, e a mensagem diz isso em vez
   * de prometer um desfecho só — quem lê precisa saber que o pior caso existe.
   */
  it('explica que o pior caso é CRIAR registro duplicado', () => {
    expect(() => chaveComposta('x', { a: '' })).toThrow(/CRIA um registro duplicado/);
  });
});
