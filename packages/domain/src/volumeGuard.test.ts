import { describe, expect, it } from 'vitest';
import { avaliarVolume, type LimitesDeVolume } from './volumeGuard';

/**
 * O teto de volume — a única guarda que olha o AGREGADO.
 *
 * As guardas por registro são cegas para "quantas?". Um `JOIN` errado no de-para
 * virando produto cartesiano gera milhares de decisões individualmente CORRETAS:
 * cada linha realmente não está no RM, cada `ESCREVER_NOVO` tem razão. O erro só
 * existe na soma, e este é o único ponto do sistema que a enxerga.
 */

const LIM: LimitesDeVolume = {
  tetoAbsoluto: 5_000,
  desvioMaxPct: 50,
  tetoEscopoPct: 30,
  pisoSemAprovacao: 50,
};

const v = (aEscrever: number, emEscopo: number, historico: number | null): string =>
  avaliarVolume({ aEscrever, emEscopo, historico }, LIM).veredito;

describe('plano vazio nunca trava o cron', () => {
  it.each([
    ['sem histórico', null],
    ['com histórico', 200],
  ])('autoriza 0 linhas %s', (_, hist) => {
    // Se um plano vazio pedisse aprovação, o cron pararia sozinho todo dia em
    // que nada mudou — que é o caso normal.
    expect(v(0, 1000, hist as number | null)).toBe('AUTORIZADO');
  });
});

describe('a primeira escrita da vida passa por humano', () => {
  it.each([1, 10, 49])('exige aprovação para %i linha(s) sem histórico', (n) => {
    // Vale mesmo abaixo do piso: é o único run em que ninguém ainda viu o writer
    // tocar o RM.
    expect(v(n, 1000, null)).toBe('PRECISA_APROVACAO');
  });

  it('e o motivo diz por quê', () => {
    const r = avaliarVolume({ aEscrever: 1, emEscopo: 1000, historico: null }, LIM);
    expect(r.motivos.join(' ')).toMatch(/primeira vez/i);
  });
});

describe('regime normal', () => {
  it.each([
    [200, 200],
    [280, 200], // +40%, dentro do teto de 50%
  ])('autoriza %i linhas com histórico %i', (n, h) => {
    expect(v(n, 2000, h)).toBe('AUTORIZADO');
  });
});

describe('desvio sobre o histórico', () => {
  it('exige aprovação a +100%', () => {
    expect(v(400, 2000, 200)).toBe('PRECISA_APROVACAO');
  });

  it('exige aprovação no caso do produto cartesiano', () => {
    // 200 linhas por run viram 3.000: a assinatura de um JOIN quebrado.
    expect(v(3000, 20000, 200)).toBe('PRECISA_APROVACAO');
  });
});

describe('percentual do escopo, mesmo sem desvio', () => {
  it('exige aprovação ao tocar 80% da janela', () => {
    expect(v(800, 1000, 800)).toBe('PRECISA_APROVACAO');
  });

  it('e o motivo aponta o escopo, não o desvio', () => {
    const r = avaliarVolume({ aEscrever: 800, emEscopo: 1000, historico: 800 }, LIM);
    expect(r.motivos.join(' ')).toMatch(/% do escopo/);
  });
});

describe('motivos acumulam', () => {
  it('reporta os DOIS gatilhos quando os dois disparam', () => {
    // Saber que estourou desvio E escopo é informação diferente de um só, e quem
    // aprova precisa disso.
    const r = avaliarVolume({ aEscrever: 900, emEscopo: 1000, historico: 100 }, LIM);
    expect(r.veredito).toBe('PRECISA_APROVACAO');
    expect(r.motivos).toHaveLength(2);
  });
});

describe('o piso protege contra ruído percentual', () => {
  it('não pede aprovação para 6 linhas, mesmo sendo +200%', () => {
    // 2 -> 6 é +200% e não significa nada. Sem o piso, correção miúda viraria
    // pedido de aprovação — e aprovação que aparece por nada é aprovação que
    // alguém passa a dar sem ler.
    expect(v(6, 1000, 2)).toBe('AUTORIZADO');
  });

  it('não pede aprovação para 50 linhas em escopo de 60 (83%)', () => {
    expect(v(50, 60, 50)).toBe('AUTORIZADO');
  });

  it('mas 51 já passa do piso e volta a valer', () => {
    expect(v(51, 60, 50)).toBe('PRECISA_APROVACAO');
  });
});

describe('teto absoluto: nem aprovação resolve', () => {
  it('aceita exatamente no limite', () => {
    expect(v(5000, 100000, 5000)).toBe('AUTORIZADO');
  });

  it.each([5001, 50_000])('recusa %i linhas', (n) => {
    // Acima do teto o número é a evidência do defeito, e um humano clicando
    // aprovar em 50.000 linhas não dá consentimento informado.
    expect(v(n, 100000, 5000)).toBe('RECUSADO');
  });

  it('e o motivo manda investigar, não aprovar', () => {
    const r = avaliarVolume({ aEscrever: 9999, emEscopo: 100000, historico: 200 }, LIM);
    expect(r.motivos.join(' ')).toMatch(/defeito estrutural/i);
  });
});

describe('divisão por zero não produz NaN', () => {
  it('escopo 0 devolve pctDoEscopo null', () => {
    const r = avaliarVolume({ aEscrever: 10, emEscopo: 0, historico: 10 }, LIM);
    expect(r.pctDoEscopo).toBeNull();
    expect(r.veredito).not.toBe('RECUSADO');
  });

  it('histórico 0 devolve pctSobreHistorico null e não trava', () => {
    const r = avaliarVolume({ aEscrever: 10, emEscopo: 100, historico: 0 }, LIM);
    expect(r.pctSobreHistorico).toBeNull();
    expect(r.veredito).toBe('AUTORIZADO');
  });
});

describe('os limites são parâmetro, não constante', () => {
  it('respeita um teto absoluto menor', () => {
    // Importa para white label: teto calibrado para 300 alunos não significa
    // nada numa escola de 3.000.
    const apertado: LimitesDeVolume = { ...LIM, tetoAbsoluto: 100 };
    expect(avaliarVolume({ aEscrever: 101, emEscopo: 1000, historico: 90 }, apertado).veredito).toBe(
      'RECUSADO',
    );
  });

  it('com piso 0, qualquer desvio acima do teto pede aprovação', () => {
    const semPiso: LimitesDeVolume = { ...LIM, pisoSemAprovacao: 0 };
    expect(avaliarVolume({ aEscrever: 6, emEscopo: 1000, historico: 2 }, semPiso).veredito).toBe(
      'PRECISA_APROVACAO',
    );
  });
});
