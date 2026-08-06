import { env, logger } from '@rm-toddle/config';
import { idMappingRepository, pgPool } from '@rm-toddle/db';
import { fetchNotasFromRm } from '@rm-toddle/domain';
import { toddleClient, wsDataServerClient } from '@rm-toddle/integrations';

/**
 * Cria a turma-disciplina 1714 no Toddle — a lacuna que a reconciliação achou.
 *
 *   npm run criar:1714                 # plano, não escreve nada
 *   npm run criar:1714 -- --executar
 *
 * `IDTURMADISC 1714` = `EAVHS10IA` / `MSHS26ELA` "ELA Higher Level", campus 2,
 * ativa, criada no RM em 09/03/2026 — quase cinco meses antes da carga manual que
 * originou as outras 185. Ficou de fora por motivo desconhecido, e por causa disso
 * 9 alunos com nota e 60 faltas não têm para onde ir.
 *
 * A turma IRMÃ existe: `1715` = "Math Higher Level — 10th grade A - 1ª série".
 * Este script replica exatamente a convenção dela.
 *
 * ─── ESCRITA COM DESFAZER PARCIAL ───────────────────────────────────────────
 *
 * Turma no Toddle NÃO tem DELETE, só `archive`. Então: ensaio por padrão, e o
 * de-para gravado imediatamente após o POST — se o processo morrer no meio, a
 * turma existiria sem identificação de volta, que foi como perdemos 186
 * mapeamentos uma vez.
 */

const ID_TURMADISC = '1714';

async function main(): Promise<void> {
  const executar = process.argv.includes('--executar');
  await toddleClient.assertTargetOrganization();

  // ─── o que o RM diz ───────────────────────────────────────────────────────
  const doRm = await wsDataServerClient.readView(
    'EduTurmaDiscData',
    `STurmaDisc.IDTURMADISC=${ID_TURMADISC} AND STurmaDisc.CODCOLIGADA=${env.RM_CODCOLIGADA}`,
    'STURMADISC',
    env.RM_CODFILIAL,
  );
  const td = doRm[0];
  if (!td) throw new Error(`IDTURMADISC ${ID_TURMADISC} não encontrada no RM.`);
  if ((td.ATIVA ?? '').toUpperCase() !== 'S') {
    throw new Error(`IDTURMADISC ${ID_TURMADISC} está ATIVA='${td.ATIVA}' no RM — não criar.`);
  }
  if (td.CODFILIAL !== env.RM_CODFILIAL) {
    throw new Error(`IDTURMADISC ${ID_TURMADISC} é do campus ${td.CODFILIAL}, fora do escopo.`);
  }

  // ─── já existe? ───────────────────────────────────────────────────────────
  const jaMapeada = await idMappingRepository.findByRmCode('COURSE', ID_TURMADISC);
  if (jaMapeada) {
    console.log(`\n  IDTURMADISC ${ID_TURMADISC} já mapeada para ${jaMapeada.toddleId}. Nada a fazer.\n`);
    return;
  }

  // ─── teacherCourseId: a convenção é serie:NN|disc:CODDISC ────────────────
  const serie = String(td.CODTURMA ?? '').slice(5, 7); // EAVHS10IA -> "10"
  const chaveTc = `serie:${serie}|disc:${td.CODDISC}`;
  const tc = await idMappingRepository.findByRmCode('TEACHER_COURSE', chaveTc);
  if (!tc) {
    throw new Error(
      `Sem teacherCourse mapeado para "${chaveTc}". O POST /courses o exige. ` +
        'Criar teacherCourse é outro fluxo (precisa de academicCourseId) — pare aqui.',
    );
  }

  // ─── título: replica a irmã 1715, mesma turma e mesmo tipo ───────────────
  const cursos = await idMappingRepository.listByType('COURSE', 'active');
  const nossos = new Map(cursos.map((c) => [c.toddleId, c.rmCode]));
  const classes = (await toddleClient.listClasses()).filter((c) => nossos.has(String(c.id)));
  const irma = classes.find((c) => nossos.get(String(c.id)) === '1715');
  if (!irma) {
    throw new Error('A turma irmã 1715 não foi encontrada — sem ela não sei a convenção do título.');
  }
  // "Math Higher Level — 10th grade A - 1ª série" -> sufixo após o travessão
  const sufixo = String(irma.title ?? '').split('—').slice(1).join('—').trim();
  const titulo = `${td.NOMEDISC} — ${sufixo}`;
  const sourceId = `rm:${env.RM_CODFILIAL}:td:${ID_TURMADISC}`;

  const curriculumProgramId = String(irma.curriculumId ?? '');
  const anos = await toddleClient.listAcademicYears();
  const academicYearId = String(anos.find((a) => a.isCurrent === true)?.id ?? '');

  // ─── alunos: quem tem nota nessa turma-disciplina ────────────────────────
  const alunosMapeados = await idMappingRepository.listByType('STUDENT', 'active');
  const studentIdPorRa = new Map(alunosMapeados.map((a) => [a.rmCode, a.toddleId]));
  const notas = await fetchNotasFromRm([ID_TURMADISC], alunosMapeados.map((a) => a.rmCode));
  const ras = [...new Set(notas.notas.map((n) => n.ra))].sort();
  const studentIds = ras.map((ra) => studentIdPorRa.get(ra)).filter((x): x is string => Boolean(x));

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  Criar a turma-disciplina ${ID_TURMADISC} no Toddle`);
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  RM:      ${td.CODTURMA}  ${td.CODDISC}  "${td.NOMEDISC}"`);
  console.log(`           campus ${td.CODFILIAL}  perlet ${td.IDPERLET}  ativa=${td.ATIVA}`);
  console.log(`           criada ${String(td.RECCREATEDON ?? '').slice(0, 10)}`);
  console.log('');
  console.log(`  irmã:    1715  "${irma.title}"`);
  console.log('');
  console.log('  vai criar:');
  console.log(`      title            "${titulo}"`);
  console.log(`      sourceId         ${sourceId}`);
  console.log(`      teacherCourseId  ${tc.toddleId}   (${chaveTc})`);
  console.log(`      curriculum       ${curriculumProgramId}`);
  console.log(`      academicYear     ${academicYearId}`);
  console.log('');
  console.log(`  alunos a vincular: ${studentIds.length} de ${ras.length} com nota`);
  if (ras.length !== studentIds.length) {
    console.log(`      ⚠ ${ras.length - studentIds.length} sem mapeamento STUDENT — ficam de fora`);
  }
  console.log('');
  console.log('  ⚠ Turma no Toddle não tem DELETE, só archive.');

  if (!executar) {
    console.log('\n  NADA FOI ESCRITO. --executar para criar.\n');
    return;
  }

  // ─── cria ─────────────────────────────────────────────────────────────────
  // A doc diverge na grafia: a tabela diz `sourcedId` e `curriculumProgramId`, o
  // exemplo de corpo diz `curriculumId`, e o GET devolve `sourceId`. Mando as
  // variantes — campo extra é ignorado, campo faltando queima o identificador.
  const courseId = await toddleClient.createClass({
    title: titulo,
    teacherCourseId: tc.toddleId,
    curriculumProgramId,
    curriculumId: curriculumProgramId,
    sourcedId: sourceId,
    sourceId,
    academicYearId,
  });

  await idMappingRepository.upsert({
    entityType: 'COURSE',
    rmCode: ID_TURMADISC,
    toddleId: courseId,
    rmInternalId: null,
  });
  logger.info({ courseId, idTurmaDisc: ID_TURMADISC, titulo }, 'Turma criada e mapeada');

  if (studentIds.length) {
    await toddleClient.addStudentsToClass(courseId, studentIds);
    logger.info({ courseId, alunos: studentIds.length }, 'Alunos vinculados');
  }

  // ─── confere ──────────────────────────────────────────────────────────────
  const depois = (await toddleClient.listClasses()).find((c) => String(c.id) === courseId);
  console.log('');
  console.log(`  criada:  ${courseId}`);
  console.log(`      title="${depois?.title}"`);
  console.log(`      sourceId=${depois?.sourceId ?? '(vazio — a grafia do campo divergiu)'}`);
  console.log(`      teacherCourseId=${(depois as Record<string, unknown> | undefined)?.teacherCourseId}`);
  console.log(`      alunos vinculados: ${studentIds.length}`);
  console.log('');
  console.log('  Falta a grade de horário: npm run seed:timetable -- --executar');
  console.log('');
}

main()
  .catch((error) => {
    logger.error({ err: error }, 'criar:1714 falhou');
    process.exitCode = 1;
  })
  .finally(() => pgPool.end());
