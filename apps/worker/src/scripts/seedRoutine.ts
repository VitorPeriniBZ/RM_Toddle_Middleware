import { env, logger } from '@rm-toddle/config';
import { idMappingRepository, pgPool } from '@rm-toddle/db';
import { toddleClient } from '@rm-toddle/integrations';

/**
 * Cria a routine do campus 2 — a peça que faltava para os timetable slots
 * materializarem.
 *
 * POR QUE PRECISA EXISTIR
 *
 * `POST /timetable-slots` devolve `{ isSuccess: true }` e NÃO cria nada quando a
 * routine do currículo não tem `bellSchedulesMapping`. Medido em 04/08/2026: a
 * única routine (`ENC`) tem o mapeamento VAZIO, e por isso nenhum slot existe no
 * currículo inteiro — e nenhuma frequência pode ser lançada no Toddle.
 *
 * POR QUE UMA ROUTINE NOVA, E NÃO EDITAR A `ENC`
 *
 * A `ENC` cobre as 15 séries do currículo, de Pre-K a Grade 12. As 185
 * turma-disciplina em escopo são só MS e HS (Grade 6 a 12). Mapear a grade do
 * campus 2 na `ENC` aplicaria esse horário ao infantil e ao Fund I, que estão
 * fora de escopo por decisão da escola.
 *
 * O RISCO QUE ESTE SCRIPT NÃO SABE RESOLVER
 *
 * As 7 séries de Grade 6 a 12 HOJE pertencem à `ENC`. Não está documentado se o
 * Toddle permite uma série em duas routines com vigências sobrepostas. Se não
 * permitir, criar esta routine pode REMOVER essas séries da `ENC` — alterando
 * configuração que não é nossa, sem pedir.
 *
 * Por isso o script lê a `ENC` ANTES e DEPOIS e relata a diferença. Se ela
 * mudar, `DELETE /routine/:id` existe e o desfazer é real.
 *
 * Uso:
 *   npm run seed:routine                 # plano, não escreve nada
 *   npm run seed:routine -- --executar   # cria
 *   npm run seed:routine -- --remover <routineId> --executar
 */

const ROUTINE_EXISTENTE = '404046160261573423'; // "ENC"
const LABEL = 'EAV Campus 2 - Grade 6-12 (RM)';

/** Segundas a sextas: os dias que a grade do RM usa (DIASEMANA 2..6). */
const DIAS = [2, 3, 4, 5, 6];

/** Grade 6 a 12 — o escopo real das 185 turma-disciplina (MS 114 + HS 71). */
const SERIE_EM_ESCOPO = /^Grade (6|7|8|9|10|11|12)$/;

const soData = (v: unknown): string => String(v ?? '').slice(0, 10);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const executar = argv.includes('--executar');
  const iRemover = argv.indexOf('--remover');
  const removerId = iRemover >= 0 ? argv[iRemover + 1] : undefined;

  await toddleClient.assertTargetOrganization();

  if (removerId) {
    if (!executar) {
      console.log(`\nRemoveria a routine ${removerId}. Adicione --executar.\n`);
      return;
    }
    await toddleClient.deleteRoutine(removerId);
    logger.info({ routineId: removerId }, 'Routine removida');
    return;
  }

  // ─── alvos ────────────────────────────────────────────────────────────────
  const cursos = await idMappingRepository.listByType('COURSE', 'active');
  const nossos = new Set(cursos.map((c) => c.toddleId));
  const classes = (await toddleClient.listClasses()).filter((c) => nossos.has(String(c.id)));
  const curriculos = [...new Set(classes.map((c) => String(c.curriculumId ?? '')))].filter(Boolean);
  if (curriculos.length !== 1) {
    throw new Error(`As turmas em escopo declaram ${curriculos.length} currículos.`);
  }
  const curriculumId = curriculos[0];

  const anos = await toddleClient.listAcademicYears();
  const atuais = anos.filter((a) => a.isCurrent === true);
  if (atuais.length !== 1) throw new Error(`Esperava 1 ano com isCurrent=true, achei ${atuais.length}.`);
  const ay = atuais[0] as Record<string, unknown>;
  const academicYearId = String(ay.id);
  const ayFim = soData(ay.end_date ?? ay.endDate);

  // ─── a grade que criamos ──────────────────────────────────────────────────
  const grades = await toddleClient.listBellSchedules([academicYearId]);
  const nossa = grades.filter((g) => String(g.label ?? '').includes('(RM)'));
  if (nossa.length !== 1) {
    throw new Error(
      `Esperava 1 bell schedule com "(RM)" no rótulo, achei ${nossa.length} ` +
        `(${nossa.map((g) => g.label).join(', ')}). Rode seed:periodos antes.`,
    );
  }
  const bellScheduleId = String(nossa[0].id);

  // ─── as séries, lidas da routine existente ────────────────────────────────
  const antes = await toddleClient.getRoutine(ROUTINE_EXISTENTE);
  const todasSeries = antes.grades ?? [];
  const emEscopo = todasSeries.filter((g) => SERIE_EM_ESCOPO.test(String(g.name ?? '')));
  if (emEscopo.length !== 7) {
    throw new Error(
      `Esperava 7 séries de Grade 6 a 12, achei ${emEscopo.length}: ` +
        `${emEscopo.map((g) => g.name).join(', ')}`,
    );
  }

  // Vigência: começo do ano letivo do RM, fim limitado ao ano acadêmico do Toddle.
  const inicio = '2026-02-03';
  const fim = ayFim;

  const payload = {
    label: LABEL,
    gradeIds: emEscopo.map((g) => String(g.id)),
    routineMode: 'OPERATIONAL_DAYS',
    startDate: inicio,
    endDate: fim,
    curriculumId,
    academicYearId,
    countHolidayAsRotationDay: false,
    bellScheduleMap: DIAS.map((weekday) => ({ weekday, bellScheduleId })),
  };

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Routine nova — campus 2, Grade 6 a 12');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  currículo        ${curriculumId}`);
  console.log(`  ano acadêmico    ${academicYearId}  (fim ${ayFim})`);
  console.log(`  grade de horário ${bellScheduleId}  "${nossa[0].label}"`);
  console.log(`  vigência         ${inicio} → ${fim}`);
  console.log(`  dias             ${DIAS.join(', ')}  (segunda a sexta)`);
  console.log('');
  console.log('  séries que ENTRAM:');
  for (const g of emEscopo) console.log(`      ${String(g.id).padEnd(20)} ${g.name}`);
  console.log('');
  console.log('  séries que FICAM DE FORA (infantil e Fund I, fora de escopo):');
  for (const g of todasSeries.filter((x) => !SERIE_EM_ESCOPO.test(String(x.name ?? '')))) {
    console.log(`      ${String(g.id).padEnd(20)} ${g.name}`);
  }
  console.log('');
  console.log(`  routine "${antes.label}" HOJE: ${todasSeries.length} séries, ` +
    `bellSchedulesMapping com ${(antes.bellSchedulesMapping ?? []).length} entrada(s)`);
  console.log('');
  console.log('  ⚠ As 7 séries de Grade 6-12 hoje pertencem à routine acima. Não está');
  console.log('    documentado se o Toddle permite uma série em duas routines. Se não');
  console.log('    permitir, esta criação pode removê-las de lá. O script confere depois.');

  if (!executar) {
    console.log('\n  NADA FOI ESCRITO. --executar para criar.');
    console.log('  DELETE /routine/:id existe — o desfazer é real.\n');
    return;
  }

  const routineId = await toddleClient.createRoutine(payload);
  logger.info({ routineId, label: LABEL }, 'Routine criada');

  // ─── a routine antiga mudou? ──────────────────────────────────────────────
  const depois = await toddleClient.getRoutine(ROUTINE_EXISTENTE);
  const seriesAntes = new Set((antes.grades ?? []).map((g) => String(g.id)));
  const seriesDepois = new Set((depois.grades ?? []).map((g) => String(g.id)));
  const perdidas = [...seriesAntes].filter((id) => !seriesDepois.has(id));

  console.log('');
  console.log(`  routine "${antes.label}": ${seriesAntes.size} séries antes, ${seriesDepois.size} depois`);
  if (perdidas.length > 0) {
    const nomes = (antes.grades ?? [])
      .filter((g) => perdidas.includes(String(g.id)))
      .map((g) => g.name);
    console.log(`  ⚠ ${perdidas.length} série(s) saíram da "${antes.label}": ${nomes.join(', ')}`);
    console.log('    O Toddle move a série para a routine nova em vez de compartilhá-la.');
    console.log(`    Se isso não era desejado: npm run seed:routine -- --remover ${routineId} --executar`);
  } else {
    console.log('  A routine existente não mudou — as séries podem estar em duas routines.');
  }

  // ─── a nova ficou com o mapeamento? ───────────────────────────────────────
  const nova = await toddleClient.getRoutine(routineId);
  const mapa = nova.bellSchedulesMapping ?? [];
  console.log('');
  console.log(`  routine nova: ${(nova.grades ?? []).length} séries, ` +
    `bellSchedulesMapping com ${mapa.length} entrada(s)`);
  if (mapa.length === 0) {
    console.log('  ⚠ O mapeamento saiu VAZIO — era exatamente o problema da "ENC". Os slots');
    console.log('    continuarão não materializando. Investigue antes de rodar seed:timetable.');
  } else {
    console.log(`  ✓ mapeamento: ${JSON.stringify(mapa).slice(0, 300)}`);
    console.log('\n  Próximo passo — a sonda dos slots (cria 1, lê de volta, aborta se falhar):');
    console.log('    npm run seed:timetable -- --executar --limite 3\n');
  }
}

main()
  .catch((error) => {
    logger.error({ err: error }, 'seed:routine falhou');
    process.exitCode = 1;
  })
  .finally(() => pgPool.end());
