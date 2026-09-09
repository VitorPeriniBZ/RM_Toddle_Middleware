import { describe, expect, it } from 'vitest';
import { achataTermGrades } from './toddleGradeSource';
import type { ToddleTermGradeStudent } from '@rm-toddle/integrations';

/**
 * O achatamento. A forma abaixo NÃO é inventada: é a resposta que o sandbox
 * devolveu em 09/09/2026, depois de criar uma nota de verdade para medir.
 *
 *   POST  postedGrade: "6"       -> aceito
 *   POST  postedGrade: "6.5"     -> HTTP 400 "For FINAL_SCORE, postedGrade
 *                                   must be an integer value."
 *   GET   score: "6.0"           <- o READ devolve com ".0", o WRITE não aceita
 *
 * O `.0` do read é o detalhe que este teste existe para fixar: `Number("6.0")`
 * dá 6, mas um parser que comparasse STRING com o valor do RM veria "6.0" e
 * "6.0000" como diferentes e reescreveria a mesma nota para sempre.
 */

const alunoComNota = (score: string | null, over: Record<string, unknown> = {}): ToddleTermGradeStudent => ({
  id: '409942184427551032',
  name: 'Aluna de Teste',
  yearGroup: 'Batch of 2026',
  ratings: [
    {
      subjectId: null,
      subjectName: null,
      teacherCourseId: '411141277652898807',
      teacherCourseTitle: 'Geografia — Grade 12',
      courseIds: [{ id: '411143049591156231', name: 'Geografia — 12th grade A - 3ª série' }],
      gradingPeriodId: '404045911547736040',
      score,
      academicCriteriaSetLabel: 'Overall score',
      academicCriteriaSetType: 'FINAL_SCORE',
      criteriaValueLabel: null,
      // Campos que a doc do Toddle não lista e a resposta real trouxe.
      isOverridden: true,
      categoryId: null,
      ...over,
    },
  ],
});

describe('achataTermGrades', () => {
  it('lê o valor de `score` quando o critério é FINAL_SCORE, com o ".0" do read', () => {
    const r = achataTermGrades([alunoComNota('6.0')]);
    expect(r.notas).toHaveLength(1);
    expect(r.notas[0].valorCru).toBe('6.0');
    expect(r.notas[0].valorNumerico).toBe(6);
    expect(r.notas[0].courseIds).toEqual(['411143049591156231']);
    expect(r.notas[0].origemId).toBe(
      '409942184427551032:411141277652898807:404045911547736040',
    );
  });

  it('conta ALUNOS e NOTAS separado — 257 edges vazios são 0 notas', () => {
    const vazios: ToddleTermGradeStudent[] = Array.from({ length: 257 }, (_, i) => ({
      id: `aluno-${i}`,
      ratings: [],
    }));
    const r = achataTermGrades(vazios);
    expect(r.alunos).toBe(257);
    expect(r.alunosComNota).toBe(0);
    expect(r.notas).toHaveLength(0);
  });

  it('lê o rótulo da escala quando o critério é GRADE_SCALE', () => {
    const r = achataTermGrades([
      alunoComNota(null, { academicCriteriaSetType: 'GRADE_SCALE', criteriaValueLabel: 'EXEM' }),
    ]);
    expect(r.notas[0].valorCru).toBe('EXEM');
    expect(r.notas[0].valorNumerico).toBeUndefined();
    expect(r.naoNumericas).toBe(1);
  });

  it('aceita vírgula decimal: Number("6,5") seria NaN em silêncio', () => {
    const r = achataTermGrades([alunoComNota('6,5')]);
    expect(r.notas[0].valorNumerico).toBe(6.5);
  });

  it('trata nulo, string vazia e a STRING "null" como sem valor', () => {
    for (const v of [null, '', 'null', '  ']) {
      const r = achataTermGrades([alunoComNota(v)]);
      expect(r.notas[0].valorCru).toBeNull();
      expect(r.semValor).toBe(1);
    }
  });

  it('descarta nota sem gradingPeriodId: não existe CODETAPA possível', () => {
    const r = achataTermGrades([alunoComNota('6.0', { gradingPeriodId: null })]);
    expect(r.notas).toHaveLength(0);
  });
});
