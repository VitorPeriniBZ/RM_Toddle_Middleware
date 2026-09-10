import { describe, expect, it } from 'vitest';
import { projetaLoteAvaliacoes, type ContextoProjecaoAvaliacao } from './assessmentProjection';
import type { EtapaNotaRm } from './gradeProjection';
import type { RmAssessmentTargets, ProvaRm } from './rmAssessmentTargets';
import type { ToddleAvaliacao, ToddleNotaAvaliacao } from './toddleAssessmentSource';

/**
 * A projeção da nota de avaliação. O que mais importa aqui é a alocação de
 * `CODPROVA`: ele é sequencial POR (turma-disciplina, etapa), e errar significa
 * escrever nota na prova de outra avaliação.
 */

// Term 2 do Toddle e etapa 2 do RM, medidos. Sobreposição: 23/06 a 04/09.
const T2 = { inicio: '2026-06-23', fim: '2026-09-22' };
const ETAPA_2 = { dtInicio: '2026-05-18', dtFim: '2026-09-04' };

const etapa: EtapaNotaRm = {
  idTurmaDisc: '1266',
  codEtapa: '2',
  ...ETAPA_2,
  permiteDigitacao: true,
  disponivelAlunos: false,
  aulasDadas: null,
};

/** Stub dos alvos do RM: só a superfície que a projeção usa. */
function alvosCom(provas: Array<Partial<ProvaRm>>): RmAssessmentTargets {
  const lista: ProvaRm[] = provas.map((p) => ({
    idTurmaDisc: '1266', codEtapa: '2', codProva: '1', descricao: '', valor: '7.0000', ...p,
  }));
  return {
    notasPorChave: new Map(),
    totalProvas: lista.length,
    totalNotas: 0,
    provasDe: (td: string, et: string) => lista.filter((p) => p.idTurmaDisc === td && p.codEtapa === et),
    proximoCodProva: (td: string, et: string) => {
      const n = lista.filter((p) => p.idTurmaDisc === td && p.codEtapa === et).map((p) => Number(p.codProva));
      return (n.length ? Math.max(...n) : 0) + 1;
    },
    descricoesDe: (td: string, et: string) =>
      new Map(lista.filter((p) => p.idTurmaDisc === td && p.codEtapa === et)
        .map((p) => [p.descricao.trim(), p.codProva])),
  } as unknown as RmAssessmentTargets;
}

function contexto(over: Partial<ContextoProjecaoAvaliacao> = {}): ContextoProjecaoAvaliacao {
  return {
    codColigada: '1',
    alunoParaRa: new Map([['aluno-1', '202600109'], ['aluno-2', '202100113']]),
    cursoParaTurmaDisc: new Map([['classe-1', '1266']]),
    periodoParaEtapa: new Map([['gp-2', '2']]),
    janelaDoPeriodo: new Map([['gp-2', T2]]),
    etapasRm: new Map([['1266|2', etapa]]),
    alvos: alvosCom([{ codProva: '4' }, { codProva: '5' }]),
    avaliacaoMapeada: new Map(),
    tiposElegiveis: ['assessment'],
    dataReferencia: '2026-08-15',
    exigirEtapaLiberada: false,
    ...over,
  };
}

const av = (over: Partial<ToddleAvaliacao> = {}): ToddleAvaliacao => ({
  assignmentId: 'a1',
  titulo: 'Prova 1',
  tipo: 'assessment/pt',
  classId: 'classe-1',
  teacherCourseId: 'tc-1',
  arquivado: false,
  ...over,
});

const nt = (over: Partial<ToddleNotaAvaliacao> = {}): ToddleNotaAvaliacao => ({
  assignmentId: 'a1',
  studentId: 'aluno-1',
  gradingPeriodId: 'gp-2',
  valorCru: '8.5',
  valor: 8.5,
  maximo: 10,
  avaliadoEm: '2026-08-15T10:00:00',
  compartilhadoEm: null,
  origemId: 'a1:aluno-1',
  ...over,
});

const motivo = (avs: ToddleAvaliacao[], nts: ToddleNotaAvaliacao[], ctx = contexto()): string => {
  const r = projetaLoteAvaliacoes(avs, nts, ctx);
  return r.recusados[0]?.motivo ?? 'PROJETADO';
};

describe('projeta o caminho felizmente completo', () => {
  it('resolve turma, aluno, etapa e aloca CODPROVA = max + 1', () => {
    const r = projetaLoteAvaliacoes([av()], [nt()], contexto());
    expect(r.recusados).toHaveLength(0);
    expect(r.projetados).toHaveLength(1);
    expect(r.projetados[0].linha).toEqual({
      codColigada: '1', codProva: '6', codEtapa: '2', idTurmaDisc: '1266',
      ra: '202600109', nota: 8.5,
    });
    // O RM já tinha as provas 4 e 5 na etapa 2, então a nova é a 6.
    expect(r.provasACriar).toHaveLength(1);
    expect(r.provasACriar[0]).toMatchObject({ codProva: '6', valor: 10, rmCode: '1266:2:6' });
    expect(r.projetados[0].chaveRm).toBe('1|6|2|N|1266|202600109');
  });
});

describe('recusas', () => {
  it('tipo fora de NOTA_TIPOS_ELEGIVEIS', () => {
    expect(motivo([av({ tipo: 'learning_engagement/le' })], [nt()])).toBe('TIPO_NAO_ELEGIVEL');
  });
  it('avaliação arquivada no Toddle', () => {
    expect(motivo([av({ arquivado: true })], [nt()])).toBe('AVALIACAO_ARQUIVADA');
  });
  it('resultado sem o assignment correspondente', () => {
    expect(motivo([], [nt()])).toBe('AVALIACAO_DESCONHECIDA');
  });
  it('turma sem de-para, e assignment sem classId', () => {
    expect(motivo([av({ classId: 'outra' })], [nt()])).toBe('TURMA_NAO_MAPEADA');
    expect(motivo([av({ classId: null })], [nt()])).toBe('TURMA_NAO_MAPEADA');
  });
  it('aluno e etapa sem de-para', () => {
    expect(motivo([av()], [nt({ studentId: 'zzz' })])).toBe('ALUNO_NAO_MAPEADO');
    expect(motivo([av()], [nt({ gradingPeriodId: 'gp-9' })])).toBe('ETAPA_NAO_MAPEADA');
  });
  it('etapa que o RM não tem, ou que não aceita digitação', () => {
    expect(motivo([av()], [nt()], contexto({ etapasRm: new Map() }))).toBe('ETAPA_NAO_GRAVAVEL');
    const travada = new Map([['1266|2', { ...etapa, permiteDigitacao: false }]]);
    expect(motivo([av()], [nt()], contexto({ etapasRm: travada }))).toBe('ETAPA_NAO_GRAVAVEL');
  });
  it('etapa não liberada quando a política exige', () => {
    expect(motivo([av()], [nt()], contexto({ exigirEtapaLiberada: true }))).toBe('ETAPA_NAO_LIBERADA');
  });
  it('janela incompatível: fora da sobreposição etapa 2 ∩ T2', () => {
    // 10/09 está em T2 mas a etapa 2 do RM fechou em 04/09.
    expect(motivo([av()], [nt()], contexto({ dataReferencia: '2026-09-10' }))).toBe('JANELA_INCOMPATIVEL');
  });
  it('nota acima do máximo da própria avaliação', () => {
    expect(motivo([av()], [nt({ valor: 11, maximo: 10 })])).toBe('NOTA_ACIMA_DO_MAXIMO');
  });
  it('sem maxScore não há SProvas.VALOR', () => {
    expect(motivo([av()], [nt({ maximo: null })])).toBe('SEM_MAXIMO');
  });
});

describe('alocação de CODPROVA — onde errar dói', () => {
  it('duas avaliações NOVAS na mesma etapa recebem números diferentes', () => {
    const r = projetaLoteAvaliacoes(
      [av({ assignmentId: 'a1', titulo: 'P1' }), av({ assignmentId: 'a2', titulo: 'P2' })],
      [nt({ assignmentId: 'a1' }), nt({ assignmentId: 'a2', origemId: 'a2:aluno-1' })],
      contexto(),
    );
    expect(r.provasACriar.map((p) => p.codProva)).toEqual(['6', '7']);
    expect(new Set(r.projetados.map((x) => x.linha.codProva)).size).toBe(2);
  });

  it('duas notas da MESMA avaliação compartilham um CODPROVA e criam UMA prova', () => {
    const r = projetaLoteAvaliacoes(
      [av()],
      [nt(), nt({ studentId: 'aluno-2', origemId: 'a1:aluno-2' })],
      contexto(),
    );
    expect(r.provasACriar).toHaveLength(1);
    expect(r.projetados.map((x) => x.linha.codProva)).toEqual(['6', '6']);
  });

  it('adota a prova que um humano já criou com o mesmo título, em vez de duplicar', () => {
    const ctx = contexto({ alvos: alvosCom([{ codProva: '4', descricao: 'Prova 1' }]) });
    const r = projetaLoteAvaliacoes([av({ titulo: 'Prova 1' })], [nt()], ctx);
    expect(r.provasACriar).toHaveLength(0);
    expect(r.projetados[0].linha.codProva).toBe('4');
    expect(r.projetados[0].provaNova).toBe(false);
  });

  it('usa o CODPROVA do de-para quando a avaliação já está mapeada', () => {
    const ctx = contexto({ avaliacaoMapeada: new Map([['a1', '1266:2:3']]) });
    const r = projetaLoteAvaliacoes([av()], [nt()], ctx);
    expect(r.provasACriar).toHaveLength(0);
    expect(r.projetados[0].linha.codProva).toBe('3');
  });

  it('recusa quando o de-para aponta para outra turma — o vínculo mudou', () => {
    const ctx = contexto({ avaliacaoMapeada: new Map([['a1', '9999:2:3']]) });
    expect(motivo([av()], [nt()], ctx)).toBe('AVALIACAO_DESCONHECIDA');
  });
});

describe('colisão de destino', () => {
  it('detecta duas notas diferentes na mesma chave do RM', () => {
    const r = projetaLoteAvaliacoes(
      [av()],
      [nt({ valor: 7 }), nt({ valor: 9, origemId: 'a1:aluno-1:b' })],
      contexto(),
    );
    expect(r.colisoes).toEqual(['1|6|2|N|1266|202600109']);
  });
});
