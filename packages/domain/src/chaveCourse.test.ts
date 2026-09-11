import { describe, expect, it } from 'vitest';
import { chaveCourse, lerChaveCourse, pareceChaveLegada } from './chaveCourse';

/**
 * A chave do de-para COURSE.
 *
 * O que estes testes protegem não é a formatação — é a propriedade que motivou a
 * troca: a chave não pode depender de nada que a cópia de base renumere, e não
 * pode virar ambígua quando uma parte falta.
 */
describe('chaveCourse', () => {
  it('monta a chave com período, turma e disciplina', () => {
    expect(chaveCourse('2026', 'EAVES01IA', 'ES26001')).toBe('2026:EAVES01IA:ES26001');
  });

  it('ignora espaço em volta, que é o que vem do XML do RM', () => {
    expect(chaveCourse(' 2026 ', ' EAVES01IA', 'ES26001 ')).toBe('2026:EAVES01IA:ES26001');
  });

  // Uma parte vazia produziria "2026::ES26001", que casaria com QUALQUER outra
  // turma igualmente furada — duas turmas diferentes no mesmo registro do Toddle.
  it.each([
    ['periodoLetivo', '', 'EAVES01IA', 'ES26001'],
    ['codTurma', '2026', '', 'ES26001'],
    ['codDisc', '2026', 'EAVES01IA', ''],
    ['codTurma só com espaço', '2026', '   ', 'ES26001'],
  ])('recusa chave com %s vazio', (_nome, per, turma, disc) => {
    expect(() => chaveCourse(per, turma, disc)).toThrow(/vazio/);
  });

  it('recusa parte que contenha o separador, porque a chave ficaria ambígua', () => {
    expect(() => chaveCourse('2026', 'EAV:ES01IA', 'ES26001')).toThrow(/ambígua/);
  });

  // O período existe na chave justamente por isto: CODTURMA não carrega o ano.
  it('separa o mesmo CODTURMA:CODDISC em períodos letivos diferentes', () => {
    expect(chaveCourse('2026', 'EAVES01IA', 'ES26001')).not.toBe(
      chaveCourse('2027', 'EAVES01IA', 'ES26001'),
    );
  });
});

describe('pareceChaveLegada', () => {
  it('reconhece o IDTURMADISC puro', () => {
    expect(pareceChaveLegada('1714')).toBe(true);
    expect(pareceChaveLegada(' 1714 ')).toBe(true);
  });

  it('não confunde a chave nova com a antiga', () => {
    expect(pareceChaveLegada('2026:EAVES01IA:ES26001')).toBe(false);
  });

  // Se um período fosse só dígitos e o resto sumisse, a migração poderia achar
  // que uma linha já migrada ainda é legada. Não acontece: a chave nova sempre
  // tem os dois separadores.
  it('não trata chave truncada como legada', () => {
    expect(pareceChaveLegada('2026:')).toBe(false);
  });
});

describe('lerChaveCourse', () => {
  it('desmonta a chave', () => {
    expect(lerChaveCourse('2026:EAVES01IA:ES26001')).toEqual({
      periodoLetivo: '2026',
      codTurma: 'EAVES01IA',
      codDisc: 'ES26001',
    });
  });

  it('devolve null para o formato antigo e para chave incompleta', () => {
    expect(lerChaveCourse('1714')).toBeNull();
    expect(lerChaveCourse('2026:EAVES01IA')).toBeNull();
    expect(lerChaveCourse('2026::ES26001')).toBeNull();
  });
});
