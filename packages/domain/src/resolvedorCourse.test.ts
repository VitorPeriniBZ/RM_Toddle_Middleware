import { describe, expect, it } from 'vitest';
import { criarResolvedorDeCourse, falhaDeCoberturaDoDePara } from './resolvedorCourse';

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

  // Duas linhas para a mesma turma apontando para o MESMO curso é duplicata
  // benigna — a migração pode ter rodado duas vezes. Resolve e segue.
  it('aceita duas linhas concordantes para a mesma turma', () => {
    const r = criarResolvedorDeCourse(
      [
        { rmCode: '2026:EAVHS10IA:HS0001', toddleId: 'c-mesmo' },
        { rmCode: '1266', toddleId: 'c-mesmo' },
      ],
      PERLET,
    );
    expect(r(td('1266', 'EAVHS10IA', 'HS0001'))).toEqual({
      toddleId: 'c-mesmo',
      convencao: 'natural',
    });
  });

  // Escolher em silêncio seria inventar uma verdade: preferir a natural vincula
  // o professor à turma errada se a linha natural estiver errada, e preferir a
  // legada recria o defeito da renumeração. Não há resposta certa a escolher.
  it('LANÇA quando as duas convenções apontam para cursos DIFERENTES', () => {
    const r = criarResolvedorDeCourse(
      [
        { rmCode: '2026:EAVHS10IA:HS0001', toddleId: 'c-um' },
        { rmCode: '1266', toddleId: 'c-outro' },
      ],
      PERLET,
    );
    expect(() => r(td('1266', 'EAVHS10IA', 'HS0001'))).toThrow(/contraditório/);
  });

  // "Contém dois-pontos" não é o teste: estas TÊM o separador e não são chaves.
  // Aceitá-las como naturais encheria o índice de chaves que nunca casam e
  // esvaziaria o balde que sinaliza linha torta.
  it('não confunde chave natural malformada com chave natural', () => {
    const r = criarResolvedorDeCourse(
      [
        { rmCode: '2026::HS0001', toddleId: 'c-a' },
        { rmCode: '2026:EAVHS10IA', toddleId: 'c-b' },
        { rmCode: '2026:EAVHS10IA:HS0001:extra', toddleId: 'c-c' },
      ],
      PERLET,
    );
    expect(r.retrato).toEqual({ natural: 0, legada: 0, desconhecida: 3 });
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

describe('falhaDeCoberturaDoDePara', () => {
  const retrato = { natural: 0, legada: 186, desconhecida: 0 };

  // O incidente de 11/09/2026, exatamente como aconteceu.
  it('acusa quando NENHUMA das turmas em escopo resolveu', () => {
    const m = falhaDeCoberturaDoDePara(0, 186, { natural: 0, legada: 0, desconhecida: 0 });
    expect(m).toMatch(/não resolveu NENHUMA das 186/);
    // A mensagem tem de dizer onde olhar, senão o alarme não endereça nada.
    expect(m).toMatch(/Convenções presentes/);
  });

  // Uma turma nova no RM que ainda não existe no Toddle é rotina. Falhar aqui
  // deixaria o fluxo vermelho por dias, e alarme sempre aceso não é alarme.
  it('não acusa quando algumas resolveram e outras não', () => {
    expect(falhaDeCoberturaDoDePara(185, 1, retrato)).toBeNull();
    expect(falhaDeCoberturaDoDePara(1, 185, retrato)).toBeNull();
  });

  it('não acusa quando está tudo mapeado', () => {
    expect(falhaDeCoberturaDoDePara(186, 0, retrato)).toBeNull();
  });

  // O buraco que esta guarda tinha no dia em que nasceu: com o RM devolvendo
  // ZERO turma-disciplina, `naoMapeadas` também é zero e ela deixava passar — o
  // mesmo "0 de 186 e verde", uma camada acima. Uma escola em atividade sempre
  // tem turma-disciplina.
  it('acusa quando o RM não devolveu turma-disciplina NENHUMA', () => {
    const m = falhaDeCoberturaDoDePara(0, 0, { natural: 0, legada: 0, desconhecida: 0 });
    expect(m).toMatch(/não devolveu NENHUMA turma-disciplina/);
    // A mensagem tem de endereçar onde olhar, senão o alarme não leva a lugar nenhum.
    expect(m).toMatch(/TODDLE\.TURMADISC/);
    expect(m).toMatch(/RM_CODFILIAL/);
  });
});
