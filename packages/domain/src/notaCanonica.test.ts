import { describe, expect, it } from 'vitest';
import { canonizarNota } from './notaCanonica';

/**
 * O caso que originou este módulo está no primeiro teste: `"9"` e `"9.0000"`
 * são a mesma nota, e tratá-los como diferentes transformava toda nota já
 * escrita em pendência falsa de "editado por fora".
 */
describe('canonizarNota', () => {
  it('iguala as duas formas que o RM e o Toddle produzem para a MESMA nota', () => {
    expect(canonizarNota('9.0000')).toBe(canonizarNota('9'));
    expect(canonizarNota('9.0000')).toBe('9');
    expect(canonizarNota('9.5000')).toBe(canonizarNota(9.5));
    expect(canonizarNota('10.0000')).toBe('10');
    expect(canonizarNota('0.0000')).toBe('0');
  });

  // O RM lê com ponto e escreve com vírgula. Comparar uma ponta com a outra
  // exige aceitar as duas como decimal.
  it('aceita vírgula e ponto como o mesmo separador decimal', () => {
    expect(canonizarNota('6,25')).toBe('6.25');
    expect(canonizarNota('6.25')).toBe('6.25');
    expect(canonizarNota('6,2500')).toBe(canonizarNota('6.25'));
  });

  it('preserva as casas que existem de verdade', () => {
    expect(canonizarNota('7.75')).toBe('7.75');
    expect(canonizarNota('8.125')).toBe('8.125');
    expect(canonizarNota('0.5')).toBe('0.5');
  });

  it('trata vazio como ausência, não como zero', () => {
    expect(canonizarNota(null)).toBeNull();
    expect(canonizarNota(undefined)).toBeNull();
    expect(canonizarNota('')).toBeNull();
    expect(canonizarNota('   ')).toBeNull();
  });

  // `-0` e `0` são a mesma nota; hashes diferentes ali reabririam o mesmo
  // defeito de pendência falsa que este módulo existe para fechar.
  it('não distingue -0 de 0', () => {
    expect(canonizarNota('-0.0000')).toBe('0');
    expect(canonizarNota('-0')).toBe(canonizarNota('0'));
  });

  // Não é validador: o que não parece número passa inteiro, para ser visto.
  it('devolve intacto o que não é número', () => {
    expect(canonizarNota('A')).toBe('A');
    expect(canonizarNota('MB')).toBe('MB');
    expect(canonizarNota('9,5,5')).toBe('9,5,5');
    expect(canonizarNota('  A  ')).toBe('A');
  });

  it('não inventa igualdade entre notas diferentes', () => {
    expect(canonizarNota('9')).not.toBe(canonizarNota('9.5'));
    expect(canonizarNota('10')).not.toBe(canonizarNota('1'));
    expect(canonizarNota('7.75')).not.toBe(canonizarNota('7.76'));
  });
});
