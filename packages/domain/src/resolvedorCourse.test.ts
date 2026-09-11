import { describe, expect, it } from 'vitest';
import { criarResolvedorDeCourse } from './resolvedorCourse';

const PERLET = '2026';
const td = (idTurmaDisc: string, codTurma: string, codDisc: string) => ({
  idTurmaDisc,
  codTurma,
  codDisc,
});

/**
 * O teste que importa é o primeiro: com o de-para INTEIRO na convenção antiga —
 * que é o estado real da produção, 198 linhas e zero na nova — a turma tem de
 * resolver. Foi não resolver que fez o sync de professores relatar
 * `turmas_nao_mapeadas: 186` e terminar como sucesso.
 */
describe('resolvedor de COURSE nas duas convenções', () => {
  it('resolve com o de-para TODO na convenção antiga (o estado da produção)', () => {
    const r = criarResolvedorDeCourse([{ rmCode: '1266', toddleId: 'c-1266' }], PERLET);
    expect(r(td('1266', 'EAVHS10IA', 'HS0001'))).toEqual({
      toddleId: 'c-1266',
      convencao: 'legada',
    });
    expect(r.retrato).toEqual({ natural: 0, legada: 1, desconhecida: 0 });
  });

  it('resolve com o de-para já migrado', () => {
    const r = criarResolvedorDeCourse(
      [{ rmCode: '2026:EAVHS10IA:HS0001', toddleId: 'c-novo' }],
      PERLET,
    );
    expect(r(td('1266', 'EAVHS10IA', 'HS0001'))).toEqual({
      toddleId: 'c-novo',
      convencao: 'natural',
    });
    expect(r.retrato).toEqual({ natural: 1, legada: 0, desconhecida: 0 });
  });

  // Durante a migração as duas convivem: é exatamente o estado que a fase de
  // expansão existe para atravessar sem janela quebrada.
  it('atravessa o de-para meio migrado, resolvendo os dois lados', () => {
    const r = criarResolvedorDeCourse(
      [
        { rmCode: '2026:EAVHS10IA:HS0001', toddleId: 'c-novo' },
        { rmCode: '1300', toddleId: 'c-velho' },
      ],
      PERLET,
    );
    expect(r(td('1266', 'EAVHS10IA', 'HS0001')).toddleId).toBe('c-novo');
    expect(r(td('1300', 'EAVHS11IB', 'HS0002')).toddleId).toBe('c-velho');
    expect(r.retrato).toEqual({ natural: 1, legada: 1, desconhecida: 0 });
  });

  // A razão de a chave ter mudado: a identity é renumerada na cópia de base. Se
  // a legada ganhasse da natural, o vínculo migrado voltaria a apontar para a
  // disciplina errada — o defeito original, de volta.
  it('a chave natural vence a legada quando as duas casariam', () => {
    const r = criarResolvedorDeCourse(
      [
        { rmCode: '2026:EAVHS10IA:HS0001', toddleId: 'c-certo' },
        { rmCode: '1266', toddleId: 'c-renumerado' },
      ],
      PERLET,
    );
    expect(r(td('1266', 'EAVHS10IA', 'HS0001'))).toEqual({
      toddleId: 'c-certo',
      convencao: 'natural',
    });
  });

  it('não acha o que não existe, e diz que não achou', () => {
    const r = criarResolvedorDeCourse([{ rmCode: '1266', toddleId: 'c-1266' }], PERLET);
    expect(r(td('9999', 'EAVHS99ZZ', 'HS9999'))).toEqual({ toddleId: null, convencao: null });
  });

  // As 12 linhas arquivadas de antes do modelo 1:1 usam `rm_code = CODTURMA`.
  // Não são nem dígitos nem chave natural: entram no balde que aparece no log,
  // em vez de casarem por engano com alguma coisa.
  it('conta à parte a terceira convenção, sem tentar adivinhá-la', () => {
    const r = criarResolvedorDeCourse([{ rmCode: 'EAVHS10IA', toddleId: 'c-?' }], PERLET);
    expect(r.retrato).toEqual({ natural: 0, legada: 0, desconhecida: 1 });
    expect(r(td('1266', 'EAVHS10IA', 'HS0001')).toddleId).toBeNull();
  });

  it('recusa período letivo vazio, em vez de não casar nada em silêncio', () => {
    expect(() => criarResolvedorDeCourse([], '')).toThrow(/periodoLetivo vazio/);
    expect(() => criarResolvedorDeCourse([], '   ')).toThrow(/periodoLetivo vazio/);
  });
});
