import { describe, expect, it } from 'vitest';
import { fracaoDoProgresso, lerProgresso } from './progresso';

/**
 * A regra que estes testes protegem é de honestidade, não de cálculo: a tela só
 * pode desenhar barra quando existe denominador de verdade. Onde o job está
 * lendo — uma Sentença do RM, as páginas do Toddle — não há "quanto falta", e
 * uma barra ali seria uma afirmação falsa.
 */
describe('fracaoDoProgresso', () => {
  it('calcula a fração quando há os dois números', () => {
    expect(fracaoDoProgresso({ fase: 'lotes', feitos: 3, total: 6 })).toBe(0.5);
    expect(fracaoDoProgresso({ fase: 'lotes', feitos: 0, total: 6 })).toBe(0);
    expect(fracaoDoProgresso({ fase: 'lotes', feitos: 6, total: 6 })).toBe(1);
  });

  // `null` e não `0`: zero desenharia uma barra vazia, que AFIRMA "não começou".
  // A ausência de denominador não é uma afirmação sobre o andamento.
  it('devolve null — nunca 0 — quando não há denominador', () => {
    expect(fracaoDoProgresso({ fase: 'lendo o RM' })).toBeNull();
    expect(fracaoDoProgresso({ fase: 'lendo', feitos: 3 })).toBeNull();
    expect(fracaoDoProgresso({ fase: 'lendo', total: 6 })).toBeNull();
    expect(fracaoDoProgresso(null)).toBeNull();
    expect(fracaoDoProgresso(undefined)).toBeNull();
  });

  it('devolve null em denominador zero, em vez de dividir por zero', () => {
    expect(fracaoDoProgresso({ fase: 'x', feitos: 0, total: 0 })).toBeNull();
  });

  it('não deixa a fração escapar de 0..1 se os contadores vierem tortos', () => {
    expect(fracaoDoProgresso({ fase: 'x', feitos: 9, total: 6 })).toBe(1);
    expect(fracaoDoProgresso({ fase: 'x', feitos: -3, total: 6 })).toBe(0);
  });
});

describe('lerProgresso', () => {
  it('lê o que o job publicou', () => {
    expect(lerProgresso({ fase: 'criando staff', feitos: 12, total: 37 })).toEqual({
      fase: 'criando staff',
      feitos: 12,
      total: 37,
    });
  });

  // Um sem o outro viraria "12/?" na tela. Descarta os dois: a fase sozinha é
  // informação honesta, "12 de sabe-se lá quanto" não é.
  it('descarta contador solto, mantendo a fase', () => {
    expect(lerProgresso({ fase: 'lendo', feitos: 12 })).toEqual({ fase: 'lendo' });
    expect(lerProgresso({ fase: 'lendo', total: 37 })).toEqual({ fase: 'lendo' });
  });

  // `job.progress` é `unknown` no BullMQ: pode ser número, string ou nada.
  it('devolve null para o que não é progresso deste projeto', () => {
    expect(lerProgresso(undefined)).toBeNull();
    expect(lerProgresso(null)).toBeNull();
    expect(lerProgresso(42)).toBeNull();
    expect(lerProgresso('metade')).toBeNull();
    expect(lerProgresso({ phase: 'reading-rm' })).toBeNull(); // formato antigo, em inglês
  });
});
