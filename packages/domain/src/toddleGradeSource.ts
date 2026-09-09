import { logger } from '@rm-toddle/config';
import type { ToddleTermGradeRating, ToddleTermGradeStudent } from '@rm-toddle/integrations';

/**
 * Achata a resposta do `GET /public/v2/term-grades` do Toddle na lista de notas
 * que a projeção consome. É a ORIGEM da via de nota Toddle -> RM (decisão D1).
 *
 * ─── POR QUE ACHATAR É UM MÓDULO, E NÃO UMA LINHA ───────────────────────────
 *
 * A resposta é aninhada: `edges[]` são ALUNOS e cada um traz `ratings[]`. Medido
 * em 09/09/2026 nesta organização: 257 edges, TODOS com `ratings: []` — ou seja
 * 257 alunos e ZERO notas. Contar `edges.length` como "notas lidas" reportaria
 * 257 registros a escrever onde não há nenhum, e o teto de volume só pegaria
 * isso depois, com a mensagem errada.
 *
 * ─── ONDE ESTÁ O VALOR: DOIS LUGARES, E ISSO É DECISIVO ─────────────────────
 *
 * `academicCriteriaSetType` discrimina onde o valor mora:
 *
 *   `FINAL_SCORE` → `score`, string numérica ("33")
 *   escala        → `criteriaValueLabel`, a ABREVIAÇÃO ("A", "EXEM")
 *
 * O RM guarda `NOTAFALTA` como decimal. Medido em 09/09/2026, as duas escalas
 * desta organização são `valueType: "ALPHA"` (EXEM/EXC/EXH/EVL/EMER/NA e A-E), e
 * a tabela de conceito do RM está VAZIA (`COD_CONCEITO` nulo em 100% de 7.268
 * linhas). Não existe régua oficial de letra para número.
 *
 * Este módulo NÃO converte: ele carrega o valor cru e diz de onde ele veio. Quem
 * recusa é a projeção, com motivo `VALOR_NAO_NUMERICO`. Inventar uma tabela de
 * conversão aqui enterraria uma decisão pedagógica da escola dentro de um
 * parser.
 */

/** Uma nota de etapa do Toddle, já achatada e com a origem preservada. */
export interface ToddleNota {
  studentId: string;
  studentName?: string;
  gradingPeriodId: string;
  /** Course-based grading: é por aqui que a EAV lança. */
  teacherCourseId: string | null;
  /** Subject-based grading: as outras escolas do white label podem usar. */
  subjectId: string | null;
  /**
   * Turmas do teacher course. É ARRAY: um teacher course pode ter várias turmas,
   * e o de-para `COURSE` mapeia IDTURMADISC -> courseId. Uma nota pode portanto
   * apontar para mais de um IDTURMADISC, e escrever em todos duplicaria a nota.
   * Quem desempata é a matrícula do aluno — ver `gradeProjection`.
   */
  courseIds: string[];
  /** `FINAL_SCORE`, `GRADE_SCALE`, … Como veio, sem normalizar. */
  criterio: string | null;
  /** O valor cru, do campo que o critério indicou. */
  valorCru: string | null;
  /** `valorCru` como número, ou `undefined` quando não é numérico. */
  valorNumerico?: number;
  /** Identificador estável desta nota, para log e fila de pendências. */
  origemId: string;
}

export interface ResumoToddleNotas {
  /** Alunos que a API devolveu (edges), não notas. */
  alunos: number;
  /** Quantos deles tinham pelo menos uma nota. */
  alunosComNota: number;
  notas: ToddleNota[];
  /** Critérios observados, para detectar mudança de configuração sem aviso. */
  porCriterio: Record<string, number>;
  /** Quantas notas vieram sem valor utilizável. */
  semValor: number;
  /** Quantas vieram com valor não numérico (escala alfabética). */
  naoNumericas: number;
}

/** Extrai o valor do campo que o critério indica. */
function valorDaRating(r: ToddleTermGradeRating): { valor: string | null; numerico?: number } {
  const criterio = (r.academicCriteriaSetType ?? '').toUpperCase();
  const bruto =
    criterio === 'FINAL_SCORE' || criterio === 'LOCAL_GRADE'
      ? r.score
      : (r.criteriaValueLabel ?? r.score);

  if (bruto === null || bruto === undefined) return { valor: null };
  const texto = String(bruto).trim();
  if (texto === '' || texto.toLowerCase() === 'null') return { valor: null };

  // Vírgula decimal existe: a escala do RM é 0 a 7 com 4 decimais, e nada
  // garante que o Toddle devolva ponto. `Number('6,5')` é NaN em silêncio.
  const normalizado = texto.replace(',', '.');
  const n = Number(normalizado);
  return Number.isFinite(n) ? { valor: texto, numerico: n } : { valor: texto };
}

/**
 * Achata alunos -> notas.
 *
 * `origemId` é `studentId:teacherCourseId|subjectId:gradingPeriodId` — a chave
 * do lado do Toddle, que é o que a fila de pendências precisa para alguém achar
 * o registro de volta na interface do professor.
 */
export function achataTermGrades(alunos: ToddleTermGradeStudent[]): ResumoToddleNotas {
  const notas: ToddleNota[] = [];
  const porCriterio: Record<string, number> = {};
  let alunosComNota = 0;
  let semValor = 0;
  let naoNumericas = 0;

  for (const aluno of alunos) {
    const ratings = aluno.ratings ?? [];
    if (ratings.length > 0) alunosComNota += 1;

    for (const r of ratings) {
      const gradingPeriodId = r.gradingPeriodId ? String(r.gradingPeriodId) : '';
      if (!gradingPeriodId) {
        // Sem grading period não existe CODETAPA possível. Isso é defeito de
        // origem, não recusa de negócio: nem chega à projeção.
        logger.warn(
          { studentId: aluno.id, teacherCourseId: r.teacherCourseId },
          'Nota do Toddle sem gradingPeriodId — descartada antes da projeção',
        );
        continue;
      }

      const criterio = r.academicCriteriaSetType ? String(r.academicCriteriaSetType) : null;
      porCriterio[criterio ?? '(sem critério)'] = (porCriterio[criterio ?? '(sem critério)'] ?? 0) + 1;

      const { valor, numerico } = valorDaRating(r);
      if (valor === null) semValor += 1;
      else if (numerico === undefined) naoNumericas += 1;

      const teacherCourseId = r.teacherCourseId ? String(r.teacherCourseId) : null;
      const subjectId = r.subjectId ? String(r.subjectId) : null;

      notas.push({
        studentId: String(aluno.id),
        studentName: aluno.name,
        gradingPeriodId,
        teacherCourseId,
        subjectId,
        courseIds: (r.courseIds ?? [])
          .map((c) => (c?.id === null || c?.id === undefined ? '' : String(c.id)))
          .filter(Boolean),
        criterio,
        valorCru: valor,
        valorNumerico: numerico,
        origemId: `${aluno.id}:${teacherCourseId ?? subjectId ?? '?'}:${gradingPeriodId}`,
      });
    }
  }

  logger.info(
    { alunos: alunos.length, alunosComNota, notas: notas.length, porCriterio, semValor, naoNumericas },
    'Notas do Toddle achatadas',
  );

  return { alunos: alunos.length, alunosComNota, notas, porCriterio, semValor, naoNumericas };
}
