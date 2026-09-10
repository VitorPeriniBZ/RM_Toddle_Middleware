import { describe, expect, it } from 'vitest';
import { avaliarFolga, cronDoProfessor } from './cronProfessor';

const AGORA = new Date('2026-09-10T12:00:00-03:00');

/**
 * A folga de 30 min entre o sync de aluno e o de professor.
 *
 * Ela existe por medição, não por estética: a janela de rate limit do Toddle é de
 * 300s, os dois falam com a MESMA organização, e o de aluno leva ~4 min fazendo
 * ~260 chamadas. Sobrepostos, os dois falham juntos — e falham por 429, o erro
 * que parece transitório e não é.
 *
 * Até a tela existir, a folga era garantida por CÁLCULO (derivar o cron do
 * professor do de aluno). Agora é garantida por VERIFICAÇÃO, e estes testes são
 * o que sustenta a troca.
 */
describe('cronDoProfessor (semente)', () => {
  it('soma 30 minutos ao horário do aluno', () => {
    expect(cronDoProfessor('0 3 * * *')).toBe('30 3 * * *');
  });

  it('entende lista de horas e escalona todas', () => {
    expect(cronDoProfessor('0 3,9,12,16 * * *')).toBe('30 3,9,12,16 * * *');
  });

  it('vira a hora quando a soma passa de 60', () => {
    expect(cronDoProfessor('45 23 * * *')).toBe('15 0 * * *');
  });

  it('cai num default PREVISÍVEL quando não entende o formato', () => {
    // Este é exatamente o comportamento que tornou a derivação inaceitável como
    // regra de runtime depois da tela: silencioso. Como SEMENTE ele é aceitável,
    // porque o valor semeado é revisável e só vale uma vez.
    expect(cronDoProfessor('*/10 * * * *')).toBe('30 3 * * *');
  });
});

describe('avaliarFolga', () => {
  it('não acusa colisão na folga de 30 min, que é a convenção', () => {
    const r = avaliarFolga('0 3 * * *', '30 3 * * *', AGORA);
    expect(r.colide).toBe(false);
    expect(r.menorFolgaMinutos).toBe(30);
    expect(r.aviso).toBeUndefined();
  });

  it('recusa horários no mesmo minuto', () => {
    const r = avaliarFolga('0 3 * * *', '0 3 * * *', AGORA);
    expect(r.colide).toBe(true);
    expect(r.menorFolgaMinutos).toBe(0);
    expect(r.motivo).toContain('300s');
  });

  it('recusa folga de 5 min: o sync de aluno leva ~4 min', () => {
    const r = avaliarFolga('0 3 * * *', '5 3 * * *', AGORA);
    expect(r.colide).toBe(true);
  });

  it('avisa, sem recusar, entre 10 e 30 min', () => {
    const r = avaliarFolga('0 3 * * *', '15 3 * * *', AGORA);
    expect(r.colide).toBe(false);
    expect(r.aviso).toContain('15 min');
  });

  it('vê colisão que a comparação de TEXTO não veria', () => {
    // Expressões diferentes que coincidem em alguns dias. Comparar strings diria
    // "são diferentes, tudo bem"; expandir os disparos mostra o encontro.
    const r = avaliarFolga('0 3 * * *', '0 3 * * 1-5', AGORA);
    expect(r.colide).toBe(true);
    expect(r.menorFolgaMinutos).toBe(0);
  });

  it('mede a MENOR distância entre os dois conjuntos de disparos', () => {
    // Aluno de hora em hora e professor às 3h30: o encontro mais próximo é 30
    // min (03:00 ou 04:00 contra 03:30), e não a distância do primeiro par.
    const r = avaliarFolga('0 6-22 * * *', '30 7 * * *', AGORA);
    expect(r.menorFolgaMinutos).toBe(30);
    expect(r.colide).toBe(false);
  });
});
