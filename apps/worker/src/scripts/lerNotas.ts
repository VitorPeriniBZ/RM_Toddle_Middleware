import { env, logger } from '@rm-toddle/config';
import { idMappingRepository, pgPool } from '@rm-toddle/db';
import { fetchNotasFromRm } from '@rm-toddle/domain';
import { toddleClient } from '@rm-toddle/integrations';

/**
 * Lê as notas do RM e relata o que iria para o `POST /term-grades`.
 * SOMENTE LEITURA — nada é escrito no RM, no Toddle nem no nosso banco.
 *
 *   npm run ler:notas
 *   npm run ler:notas -- --detalhe
 */
async function main(): Promise<void> {
  const detalhe = process.argv.includes('--detalhe');

  const cursos = await idMappingRepository.listByType('COURSE', 'active');
  const alunos = await idMappingRepository.listByType('STUDENT', 'active');
  const etapas = await idMappingRepository.listByType('GRADING_PERIOD', 'active');

  const studentIdPorRa = new Map(alunos.map((a) => [a.rmCode, a.toddleId]));
  const gradingPorEtapa = new Map(etapas.map((e) => [e.rmCode, e.toddleId]));

  // teacherCourseId vem da própria turma no Toddle — o currículo é COURSE_BASED_GRADING.
  const nossos = new Set(cursos.map((c) => c.toddleId));
  const classes = (await toddleClient.listClasses()).filter((c) => nossos.has(String(c.id)));
  const courseIdPorTd = new Map(cursos.map((c) => [c.rmCode, c.toddleId]));
  const tcPorCourseId = new Map(
    classes.map((c) => [String(c.id), String((c as Record<string, unknown>).teacherCourseId ?? '')]),
  );
  const curriculumProgramId = [...new Set(classes.map((c) => String(c.curriculumId ?? '')))][0];
  const anos = await toddleClient.listAcademicYears();
  const academicYearId = String(anos.find((a) => a.isCurrent === true)?.id ?? '');

  const r = await fetchNotasFromRm(cursos.map((c) => c.rmCode), alunos.map((a) => a.rmCode));

  type Motivo = 'SEM_NOTA' | 'ETAPA_SEM_DEPARA' | 'SEM_TEACHER_COURSE' | 'ALUNO_INATIVO' | 'ETAPA_NAO_LIBERADA';
  const recusas: Record<string, number> = {};
  const prontas: typeof r.notas = [];

  for (const n of r.notas) {
    const courseId = courseIdPorTd.get(n.idTurmaDisc);
    const tc = courseId ? tcPorCourseId.get(courseId) : undefined;
    let motivo: Motivo | null = null;
    if (!n.nota) motivo = 'SEM_NOTA';
    else if (!gradingPorEtapa.has(n.codEtapa)) motivo = 'ETAPA_SEM_DEPARA';
    else if (!tc) motivo = 'SEM_TEACHER_COURSE';
    else if (!n.alunoAtivo) motivo = 'ALUNO_INATIVO';
    if (motivo) recusas[motivo] = (recusas[motivo] ?? 0) + 1;
    else prontas.push(n);
  }
  const bloqueadasPorLiberacao = prontas.filter((n) => !n.etapaLiberada).length;

  const p = (s = ''): void => console.log(s);
  p('');
  p('══════════════════════════════════════════════════════════════════');
  p('  Notas do RM — SOMENTE LEITURA. Nada foi escrito.');
  p('══════════════════════════════════════════════════════════════════');
  p(`  sentença   ${env.RM_SENTENCA_NOTAS}`);
  p(`  currículo  ${curriculumProgramId}   ano ${academicYearId}`);
  p('');
  p('── o que o RM devolveu ───────────────────────────────────────────');
  p(`  linhas                       ${r.linhas}`);
  p(`  em escopo                    ${r.notas.length}`);
  p(`  fora do escopo               ${r.foraDoEscopo}`);
  p(`  sem nota lançada             ${r.semNota}`);
  p(`  faixa da nota                ${r.faixaNota ? `${r.faixaNota.min} a ${r.faixaNota.max}` : '—'}`);
  p(`  por etapa                    ${JSON.stringify(r.dominioEtapa)}`);
  p(`  marca d'água (ALTERADO_EM)   ${r.marcaDagua ?? '—'}`);
  p('');
  p('── de-para ───────────────────────────────────────────────────────');
  p(`  COURSE ${cursos.length}   STUDENT ${alunos.length}   GRADING_PERIOD ${etapas.length}`);
  for (const e of [...etapas].sort((a, b) => a.rmCode.localeCompare(b.rmCode))) {
    p(`      etapa ${e.rmCode} → ${e.toddleId}`);
  }
  p('');
  p('── projeção ──────────────────────────────────────────────────────');
  p(`  RESOLVIDAS                   ${prontas.length} de ${r.notas.length}`);
  if (Object.keys(recusas).length) {
    for (const [m, n] of Object.entries(recusas).sort((a, b) => b[1] - a[1])) {
      p(`      ${m.padEnd(22)} ${String(n).padStart(6)}`);
    }
  }
  p('');
  p('── ⚠ O BLOQUEIO ──────────────────────────────────────────────────');
  p(`  em etapa LIBERADA:      ${r.emEtapaLiberada}`);
  p(`  em etapa NÃO liberada:  ${bloqueadasPorLiberacao}`);
  p('');
  p('  Publicar nota de etapa não liberada mostra à família resultado');
  p('  provisório. Sob essa regra, PUBLICÁVEIS HOJE = ' + r.emEtapaLiberada + '.');
  p('');
  p('  A flag está N em 100% — inclusive no 1º trimestre, que fechou em maio.');
  p('  Falta a escola dizer se ela é gerenciada ou se nunca é tocada.');

  if (detalhe && prontas.length) {
    p('');
    p('── amostra do payload term-grades ────────────────────────────────');
    for (const n of prontas.slice(0, 3)) {
      const courseId = courseIdPorTd.get(n.idTurmaDisc) as string;
      p('  {');
      p(`    "studentId": "${studentIdPorRa.get(n.ra)}",`);
      p(`    "gradingPeriodId": "${gradingPorEtapa.get(n.codEtapa)}",`);
      p(`    "teacherCourseId": "${tcPorCourseId.get(courseId)}",`);
      p(`    "curriculumProgramId": "${curriculumProgramId}",`);
      p(`    "academicYearId": "${academicYearId}",`);
      p(`    "postedGrade": "${n.nota}"`);
      p(`  }   // RA ${n.ra} · ${n.disciplina} · etapa ${n.codEtapa} · liberada=${n.etapaLiberada ? 'S' : 'N'}`);
      p('');
    }
    p('  Sem gradeScaleId e sem criteriaType: é overall score numérico.');
    p('  A tabela de conceito do RM está vazia, então não há régua para letra.');
  }

  p('');
  p('══════════════════════════════════════════════════════════════════');
  p('  Nada foi escrito.');
  p('══════════════════════════════════════════════════════════════════');
  p('');
}

main()
  .catch((error) => {
    logger.error({ err: error }, 'ler:notas falhou');
    process.exitCode = 1;
  })
  .finally(() => pgPool.end());
