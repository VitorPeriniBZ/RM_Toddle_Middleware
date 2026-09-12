import { describe, expect, it } from 'vitest';
import {
  ambiguidadesDeEtapa,
  chaveNaturalNota,
  janelaCompativel,
  projetaNota,
  projetaLoteNotas,
  type ContextoProjecaoNota,
  type EtapaNotaRm,
} from './gradeProjection';
import type { ToddleNota } from './toddleGradeSource';

/**
 * A projeção da nota. O teste que importa mais é o da JANELA: é ele que separa
 * "nota no 3º trimestre" de "nota gravada na etapa 2 do registro acadêmico".
 *
 * As datas abaixo são as MEDIDAS em 06/08/2026 e registradas na D2, não
 * inventadas:
 *
 *   Toddle T1  2025-11-21 → 2026-06-22     RM etapa 1  2026-02-03 → 2026-05-15
 *   Toddle T2  2026-06-23 → 2026-09-22     RM etapa 2  2026-05-18 → 2026-09-04
 *   Toddle T3  2026-09-23 → 2026-11-20     RM etapa 3  2026-09-09 → 2026-12-11
 */

const T1 = { inicio: '2025-11-21', fim: '2026-06-22' };
const T2 = { inicio: '2026-06-23', fim: '2026-09-22' };
const T3 = { inicio: '2026-09-23', fim: '2026-11-20' };

const ETAPA_1 = { dtInicio: '2026-02-03', dtFim: '2026-05-15' };
const ETAPA_2 = { dtInicio: '2026-05-18', dtFim: '2026-09-04' };
const ETAPA_3 = { dtInicio: '2026-09-09', dtFim: '2026-12-11' };

describe('janelaCompativel — as três faixas da D2', () => {
  it('libera onde as janelas se sobrepõem e a data está dentro', () => {
    // 1º trimestre inteiro: etapa 1 ⊂ T1.
    expect(janelaCompativel('2026-03-10', ETAPA_1, T1).ok).toBe(true);
    // Miolo do 2º: etapa 2 ∩ T2.
    expect(janelaCompativel('2026-07-15', ETAPA_2, T2).ok).toBe(true);
    // Miolo do 3º: etapa 3 ∩ T3.
    expect(janelaCompativel('2026-10-01', ETAPA_3, T3).ok).toBe(true);
  });

  it('recusa 18/05→22/06: está em T1, mas a etapa 1 do RM já fechou', () => {
    const r = janelaCompativel('2026-06-01', ETAPA_1, T1);
    expect(r.ok).toBe(false);
    expect(r.porque).toContain('aponta para a etapa errada');
  });

  it('recusa 09/09→22/09: está em T2, mas a etapa 2 do RM já fechou', () => {
    // A faixa em que este projeto estava quando a via de nota foi construída.
    const r = janelaCompativel('2026-09-09', ETAPA_2, T2);
    expect(r.ok).toBe(false);
  });

  it('recusa quando as janelas não se cruzam de jeito nenhum', () => {
    // Etapa 3 (a partir de 09/09) contra T1 (até 22/06): sem interseção.
    const r = janelaCompativel('2026-10-01', ETAPA_3, T1);
    expect(r.ok).toBe(false);
    expect(r.porque).toContain('não se cruzam');
  });

  it('recusa quando o grading period não tem vigência conhecida', () => {
    expect(janelaCompativel('2026-03-10', ETAPA_1, undefined).ok).toBe(false);
  });

  it('recusa 21/11→11/12: dezembro não tem T que o cubra', () => {
    // T3 termina em 20/11 e a etapa 3 do RM vai até 11/12. Uma nota lançada em
    // dezembro cai fora da sobreposição.
    const r = janelaCompativel('2026-12-01', ETAPA_3, T3);
    expect(r.ok).toBe(false);
  });
});

// ─── projeção completa ──────────────────────────────────────────────────────

const etapa = (codEtapa: string, janela: { dtInicio: string; dtFim: string }, liberada = true): EtapaNotaRm => ({
  idTurmaDisc: '1266',
  codEtapa,
  dtInicio: janela.dtInicio,
  dtFim: janela.dtFim,
  permiteDigitacao: true,
  disponivelAlunos: liberada,
  aulasDadas: '40',
});

function contexto(over: Partial<ContextoProjecaoNota> = {}): ContextoProjecaoNota {
  return {
    codColigada: '1',
    alunoParaRa: new Map([['aluno-1', '202600001']]),
    cursoParaTurmaDisc: new Map([['curso-1', '1266']]),
    periodoParaEtapa: new Map([['gp-1', '1']]),
    janelaDoPeriodo: new Map([['gp-1', T1]]),
    etapasRm: new Map([['1266|1', etapa('1', ETAPA_1)]]),
    dataReferencia: '2026-03-10',
    faixaNota: { min: 0, max: 7 },
    exigirEtapaLiberada: false,
    ...over,
  };
}

const nota = (over: Partial<ToddleNota> = {}): ToddleNota => ({
  studentId: 'aluno-1',
  gradingPeriodId: 'gp-1',
  teacherCourseId: 'tc-1',
  subjectId: null,
  courseIds: ['curso-1'],
  criterio: 'FINAL_SCORE',
  valorCru: '6.5',
  valorNumerico: 6.5,
  origemId: 'aluno-1:tc-1:gp-1',
  ...over,
});

const motivo = (n: ToddleNota, ctx = contexto()): string => {
  const r = projetaNota(n, ctx);
  return 'motivo' in r ? r.motivo : 'PROJETADO';
};

describe('projetaNota', () => {
  it('projeta a linha completa quando tudo resolve', () => {
    const r = projetaNota(nota(), contexto());
    expect('linha' in r).toBe(true);
    if (!('linha' in r)) return;
    expect(r.linha).toEqual({
      codColigada: '1',
      ra: '202600001',
      idTurmaDisc: '1266',
      codEtapa: '1',
      tipoEtapa: 'N',
      nota: '6.5',
    });
    // A chave segue a ordem do `xs:unique` do XSD: coligada, etapa, tipo, td, ra.
    expect(r.chaveRm).toBe('1|1|N|1266|202600001');
  });

  it('recusa nota sem valor — etapa aberta, professor não lançou', () => {
    expect(motivo(nota({ valorCru: null, valorNumerico: undefined }))).toBe('SEM_VALOR');
  });

  it('recusa valor alfabético: não há régua oficial de letra para número', () => {
    expect(motivo(nota({ valorCru: 'EXEM', valorNumerico: undefined, criterio: 'GRADE_SCALE' })))
      .toBe('VALOR_NAO_NUMERICO');
  });

  it('recusa nota fora da escala 0–7 do RM', () => {
    expect(motivo(nota({ valorCru: '9', valorNumerico: 9 }))).toBe('NOTA_FORA_DA_FAIXA');
    expect(motivo(nota({ valorCru: '-1', valorNumerico: -1 }))).toBe('NOTA_FORA_DA_FAIXA');
  });

  it('recusa o que não tem de-para', () => {
    expect(motivo(nota({ studentId: 'desconhecido' }))).toBe('ALUNO_NAO_MAPEADO');
    expect(motivo(nota({ gradingPeriodId: 'gp-9' }))).toBe('ETAPA_NAO_MAPEADA');
    expect(motivo(nota({ courseIds: ['curso-9'], teacherCourseId: null }))).toBe('TURMA_NAO_MAPEADA');
  });

  it('recusa etapa que o RM não tem ou que não aceita digitação', () => {
    expect(motivo(nota(), contexto({ etapasRm: new Map() }))).toBe('ETAPA_NAO_GRAVAVEL');
    const calculada = { ...etapa('1', ETAPA_1), permiteDigitacao: false };
    expect(motivo(nota(), contexto({ etapasRm: new Map([['1266|1', calculada]]) })))
      .toBe('ETAPA_NAO_GRAVAVEL');
  });

  it('recusa etapa não liberada quando a política exige liberação', () => {
    const ctx = contexto({
      etapasRm: new Map([['1266|1', etapa('1', ETAPA_1, false)]]),
      exigirEtapaLiberada: true,
    });
    expect(motivo(nota(), ctx)).toBe('ETAPA_NAO_LIBERADA');
    // Com a política desligada, a mesma nota passa.
    expect(motivo(nota(), { ...ctx, exigirEtapaLiberada: false })).toBe('PROJETADO');
  });

  it('recusa a janela incompatível mesmo com todo o resto resolvido', () => {
    // Mesma nota, mesma etapa — só a data de referência muda para dentro da
    // faixa em que o ordinal mente.
    expect(motivo(nota(), contexto({ dataReferencia: '2026-06-01' }))).toBe('JANELA_INCOMPATIVEL');
  });
});

describe('fan-out de courseIds — um teacher course, várias turmas', () => {
  const ctxDuas = (turmaDiscDoAluno?: Map<string, Set<string>>): ContextoProjecaoNota =>
    contexto({
      cursoParaTurmaDisc: new Map([
        ['curso-1', '1266'],
        ['curso-2', '1267'],
      ]),
      etapasRm: new Map([
        ['1266|1', etapa('1', ETAPA_1)],
        ['1267|1', { ...etapa('1', ETAPA_1), idTurmaDisc: '1267' }],
      ]),
      turmaDiscDoAluno,
    });

  const duasTurmas = nota({ courseIds: ['curso-1', 'curso-2'], teacherCourseId: null });

  it('recusa quando não há matrícula para desempatar', () => {
    expect(motivo(duasTurmas, ctxDuas())).toBe('TURMA_AMBIGUA');
  });

  it('recusa quando a matrícula não desempata (aluno nas duas)', () => {
    const nasDuas = new Map([['202600001', new Set(['1266', '1267'])]]);
    expect(motivo(duasTurmas, ctxDuas(nasDuas))).toBe('TURMA_AMBIGUA');
  });

  it('resolve pela matrícula quando ela aponta para UMA', () => {
    const numa = new Map([['202600001', new Set(['1267'])]]);
    const r = projetaNota(duasTurmas, ctxDuas(numa));
    expect('linha' in r).toBe(true);
    if ('linha' in r) expect(r.linha.idTurmaDisc).toBe('1267');
  });
});

describe('projetaLoteNotas', () => {
  it('conta os motivos e detecta colisão de destino', () => {
    // Duas notas DIFERENTES do Toddle que caem na mesma chave do RM. Não é
    // duplicata: é ambiguidade, e escolher uma seria chute.
    const r = projetaLoteNotas(
      [
        nota({ origemId: 'a', valorCru: '6', valorNumerico: 6 }),
        nota({ origemId: 'b', valorCru: '7', valorNumerico: 7, teacherCourseId: 'tc-2' }),
        nota({ origemId: 'c', valorCru: null, valorNumerico: undefined }),
      ],
      contexto(),
    );
    expect(r.projetados).toHaveLength(2);
    expect(r.porMotivo).toEqual({ SEM_VALOR: 1 });
    expect(r.colisoes).toEqual(['1|1|N|1266|202600001']);
  });
});

describe('chaveNaturalNota', () => {
  it('usa a ordem do xs:unique do XSD, e o tipo é sempre N', () => {
    expect(chaveNaturalNota({ codColigada: '1', codEtapa: '3', idTurmaDisc: '99', ra: 'RA1' }))
      .toBe('1|3|N|99|RA1');
  });
});

/**
 * O caso real, medido em 12/09/2026: o T2 do Toddle cruza a etapa 2 E a etapa 3
 * do RM. As duas passam no teste de cruzamento, e nada no sistema diria que há
 * duas respostas possíveis.
 */
describe('ambiguidadesDeEtapa', () => {
  const ETAPAS = [
    { codEtapa: '1', dtInicio: '2026-02-03', dtFim: '2026-05-15' },
    { codEtapa: '2', dtInicio: '2026-05-18', dtFim: '2026-09-04' },
    { codEtapa: '3', dtInicio: '2026-09-09', dtFim: '2026-12-11' },
  ];
  const DE_PARA = new Map([
    ['gp-t1', '1'],
    ['gp-t2', '2'],
    ['gp-t3', '3'],
  ]);

  it('acusa o T2 real, que cruza a etapa 2 e a etapa 3', () => {
    const janelas = new Map([['gp-t2', { inicio: '2026-06-23', fim: '2026-09-22' }]]);
    const [a] = ambiguidadesDeEtapa(janelas, ETAPAS, DE_PARA);

    expect(a.gradingPeriodId).toBe('gp-t2');
    expect(a.candidatas.map((c) => c.codEtapa)).toEqual(['2', '3']);
    expect(a.mapeadaPara).toBe('2');
    // 09/09 a 22/09 = 14 dias inclusivos. É o tamanho do risco, e ele aparece.
    expect(a.candidatas.find((c) => c.codEtapa === '3')?.diasDeSobreposicao).toBe(14);
  });

  // A maior sobreposição vem primeiro para quem lê, mas a função NÃO escolhe:
  // escolher seria trocar uma heurística por outra, e o dado que falta é
  // semântico, não temporal.
  it('ordena por tamanho da sobreposição, sem escolher nenhuma', () => {
    const janelas = new Map([['gp-t2', { inicio: '2026-06-23', fim: '2026-09-22' }]]);
    const [a] = ambiguidadesDeEtapa(janelas, ETAPAS, DE_PARA);
    expect(a.candidatas[0].codEtapa).toBe('2');
    expect(a.candidatas[0].diasDeSobreposicao).toBeGreaterThan(
      a.candidatas[1].diasDeSobreposicao,
    );
  });

  it('não acusa período que cruza uma etapa só', () => {
    const janelas = new Map([['gp-t3', { inicio: '2026-09-23', fim: '2026-11-20' }]]);
    expect(ambiguidadesDeEtapa(janelas, ETAPAS, DE_PARA)).toEqual([]);
  });

  it('não acusa período que não cruza nenhuma', () => {
    const janelas = new Map([['gp-x', { inicio: '2027-01-05', fim: '2027-01-30' }]]);
    expect(ambiguidadesDeEtapa(janelas, ETAPAS, DE_PARA)).toEqual([]);
  });

  // Sem de-para a ambiguidade é pior, não melhor: ninguém sequer declarou qual
  // é a certa. Tem de aparecer, e dizendo que está sem.
  it('acusa também quando não há de-para para o período', () => {
    const janelas = new Map([['gp-orfao', { inicio: '2026-06-23', fim: '2026-09-22' }]]);
    const [a] = ambiguidadesDeEtapa(janelas, ETAPAS, new Map());
    expect(a.mapeadaPara).toBe('(sem de-para)');
    expect(a.candidatas).toHaveLength(2);
  });
});

/**
 * Este motivo respondeu por 558 de 558 recusas. A frase antiga dizia o que
 * aconteceu e não o que fazer — e quem lia não sabia qual data mexer, em qual
 * dos dois sistemas. Uma recusa que não endereça ninguém deixa o fluxo parado
 * com cara de problema técnico, quando é cadastral e tem dono.
 */
describe('a recusa por janela diz o que fazer', () => {
  const etapa = { dtInicio: '2026-05-18', dtFim: '2026-09-04' };
  const janela = { inicio: '2026-06-23', fim: '2026-09-22' };

  it('janela fechada: nomeia a data e os dois caminhos de conserto', () => {
    const r = janelaCompativel('2026-09-12', etapa, janela);
    expect(r.ok).toBe(false);
    expect(r.porque).toContain('FECHOU em 2026-09-04');
    expect(r.porque).toContain('no Toddle, encerre este período em 2026-09-04');
    expect(r.porque).toContain('no RM, estenda a etapa');
    expect(r.porque).toContain('decisão de calendário');
  });

  it('janela ainda não aberta: diz a data em que abre', () => {
    const r = janelaCompativel('2026-06-01', etapa, janela);
    expect(r.ok).toBe(false);
    expect(r.porque).toContain('ABRE em 2026-06-23');
  });

  it('dentro da janela segue passando, sem recado nenhum', () => {
    const r = janelaCompativel('2026-08-01', etapa, janela);
    expect(r.ok).toBe(true);
    expect(r.porque).not.toContain('FECHOU');
  });
});
