import { describe, expect, it } from 'vitest';
import { assuntoDoSinal, avaliarCruzamento, type EntradaDoSinal } from './sinalDeCruzamento';

/**
 * O DETECTOR DO MODO DE FALHA QUE NÃO PRODUZ ERRO.
 *
 * Quando a chave natural degrada, `decidirEscrita` continua rodando, os 15
 * testes dela continuam passando, a fila fica verde, a DLQ fica vazia — e a
 * proteção contra sobrescrever lançamento de professor está desligada.
 *
 * Nenhum dos mecanismos deste projeto pega isso. Estes números pegam.
 */

const entrada = (m: Partial<EntradaDoSinal> = {}): EntradaDoSinal => ({
  lidasDoRm: 2449,
  chavesUnicasDoRm: 2449,
  porVeredito: { NADA_A_FAZER: 2400, ESCREVER_NOVO: 40, CONFLITO_HUMANO: 9 },
  ...m,
});

describe('o dia normal não alerta', () => {
  it('a maioria já está no RM e algumas são novas', () => {
    expect(avaliarCruzamento(entrada()).suspeito).toBe(false);
  });

  it('tudo já está lá e nada há a fazer', () => {
    const r = avaliarCruzamento(entrada({ porVeredito: { NADA_A_FAZER: 2449 } }));
    expect(r.suspeito).toBe(false);
  });

  it('conflito humano é casamento — a trava funcionando é o oposto de alarme', () => {
    // CONFLITO_HUMANO significa que ACHAMOS a linha e recusamos sobrescrever.
    // É a trava fazendo o trabalho dela; alertar aqui seria alarme por acerto.
    const r = avaliarCruzamento(entrada({ porVeredito: { CONFLITO_HUMANO: 2449 } }));
    expect(r.suspeito).toBe(false);
  });
});

describe('primeira execução NÃO é falso positivo', () => {
  /**
   * ─── POR QUE ISTO NÃO É UM LIMIAR DE PORCENTAGEM ─────────────────────────
   *
   * A tentação óbvia é alertar quando `ESCREVER_NOVO` passa de X%. Não serve:
   * numa primeira execução, 100% de ESCREVER_NOVO é o CERTO — o RM está vazio e
   * tudo é novo mesmo.
   *
   * Um limiar de porcentagem confundiria "primeira vez" com "a trava
   * desligou", que são o oposto um do outro. O discriminador é a CONTRADIÇÃO:
   * o RM ter dado E nada casar.
   */
  it('RM vazio com tudo novo: 100% ESCREVER_NOVO e nenhum alarme', () => {
    const r = avaliarCruzamento(
      entrada({ lidasDoRm: 0, chavesUnicasDoRm: 0, porVeredito: { ESCREVER_NOVO: 2449 } }),
    );
    expect(r.suspeito).toBe(false);
  });

  it('janela sem aula: nada lido, nada decidido, nenhum alarme', () => {
    const r = avaliarCruzamento(entrada({ lidasDoRm: 0, chavesUnicasDoRm: 0, porVeredito: {} }));
    expect(r.suspeito).toBe(false);
  });

  it('RM com dados mas nada a decidir hoje: nenhum alarme', () => {
    // O Toddle não trouxe nada nesta janela. Não é contradição, é dia parado.
    const r = avaliarCruzamento(entrada({ porVeredito: {} }));
    expect(r.suspeito).toBe(false);
  });
});

describe('a assinatura da trava desligada', () => {
  /**
   * O RM tem 2.449 faltas e ZERO casou. Não existe leitura inocente: ou a chave
   * degradou, ou a janela está errada. Nos dois casos ninguém deveria escrever.
   */
  it('RM com dados e nada casou: suspeito', () => {
    const r = avaliarCruzamento(entrada({ porVeredito: { ESCREVER_NOVO: 2449 } }));
    expect(r.suspeito).toBe(true);
    expect(r.motivos).toContain('nada-casou');
    expect(r.casaram).toBe(0);
  });

  it('a frase nomeia os dois números que se contradizem', () => {
    const r = avaliarCruzamento(entrada({ porVeredito: { ESCREVER_NOVO: 2449 } }));
    expect(r.porque).toContain('2449');
    expect(r.porque).toContain('NENHUMA');
  });

  it('UM casamento já basta para não ser a assinatura', () => {
    // O sinal é a contradição total. Um único casamento significa que a chave
    // ainda funciona, e o resto tem outra explicação — que não é esta.
    const r = avaliarCruzamento(entrada({ porVeredito: { ESCREVER_NOVO: 2448, NADA_A_FAZER: 1 } }));
    expect(r.motivos).not.toContain('nada-casou');
  });

  it('REMOCAO_PEDE_HUMANO também conta como casamento', () => {
    // Ela só existe porque ACHAMOS a linha no RM e a origem não a tem mais.
    const r = avaliarCruzamento(entrada({ porVeredito: { REMOCAO_PEDE_HUMANO: 2449 } }));
    expect(r.suspeito).toBe(false);
  });
});

describe('colisão de chave — o que a distribuição sozinha não pega', () => {
  /**
   * Duas aulas do mesmo aluno no mesmo dia diferem só por IDTURMADISC e
   * IDHORARIOTURMA — as duas colunas que o `?? ''` degrada. Colapsadas na mesma
   * chave, `indexaFaltasPorChave` descarta uma e a linha SOME.
   *
   * As que sobram podem casar normalmente, então a distribuição de vereditos
   * fica com cara de saudável. O sinal aqui é aritmético e independente dela.
   */
  it('menos chaves que linhas: suspeito, mesmo com a distribuição normal', () => {
    const r = avaliarCruzamento(entrada({ lidasDoRm: 2449, chavesUnicasDoRm: 1300 }));
    expect(r.suspeito).toBe(true);
    expect(r.motivos).toEqual(['colisao-de-chave']);
    expect(r.linhasPerdidas).toBe(1149);
  });

  it('UMA linha perdida já é sinal — é falta de aluno, não estatística', () => {
    const r = avaliarCruzamento(entrada({ lidasDoRm: 2449, chavesUnicasDoRm: 2448 }));
    expect(r.suspeito).toBe(true);
    expect(r.linhasPerdidas).toBe(1);
  });

  it('a frase nomeia quantas sumiram', () => {
    const r = avaliarCruzamento(entrada({ lidasDoRm: 10, chavesUnicasDoRm: 4 }));
    expect(r.porque).toContain('6');
    expect(r.porque).toContain('colisão');
  });

  it('nunca reporta perda negativa', () => {
    // Defensivo: chaves > linhas não deveria acontecer, e se acontecer o
    // relatório não pode sair dizendo "-3 linhas sumiram".
    const r = avaliarCruzamento(entrada({ lidasDoRm: 5, chavesUnicasDoRm: 8 }));
    expect(r.linhasPerdidas).toBe(0);
    expect(r.motivos).not.toContain('colisao-de-chave');
  });
});

describe('os dois sinais juntos', () => {
  it('a chave degradou de vez: colidiu E nada casou', () => {
    // O cenário completo do `?? ''`: as colunas somem, as linhas colapsam
    // entre si, e as chaves resultantes não batem com nada da projeção.
    const r = avaliarCruzamento({
      lidasDoRm: 2449,
      chavesUnicasDoRm: 900,
      porVeredito: { ESCREVER_NOVO: 2449 },
    });
    expect(r.motivos).toEqual(['nada-casou', 'colisao-de-chave']);
    expect(r.porque).toContain('NENHUMA');
    expect(r.porque).toContain('colisão');
  });
});

describe('assunto estável — contrato do P0-2', () => {
  it('não carrega número nenhum: contagem muda a cada passada', () => {
    expect(assuntoDoSinal('Frequência', 'nada-casou')).not.toMatch(/\d/);
    expect(assuntoDoSinal('Frequência', 'colisao-de-chave')).not.toMatch(/\d/);
  });

  it('é estável para o mesmo fluxo e motivo', () => {
    expect(assuntoDoSinal('Frequência', 'nada-casou')).toBe(
      assuntoDoSinal('Frequência', 'nada-casou'),
    );
  });

  it('motivos diferentes são incidentes diferentes', () => {
    // "nada casou" manda olhar a Sentença e a janela; "colisão" manda olhar as
    // colunas da chave. Consertos diferentes, janelas de supressão separadas.
    expect(assuntoDoSinal('Frequência', 'nada-casou')).not.toBe(
      assuntoDoSinal('Frequência', 'colisao-de-chave'),
    );
  });

  it('fluxos diferentes são incidentes diferentes', () => {
    expect(assuntoDoSinal('Frequência', 'nada-casou')).not.toBe(
      assuntoDoSinal('Notas', 'nada-casou'),
    );
  });
});
