import { logger } from '@rm-toddle/config';
import { idMappingRepository, pgPool } from '@rm-toddle/db';
import { toddleClient } from '@rm-toddle/integrations';

/**
 * Liga a grade de horário do RM à routine do currículo — a peça que falta para os
 * timetable slots materializarem.
 *
 * POR QUE PRECISA EXISTIR
 *
 * `POST /timetable-slots` devolve `{ isSuccess: true }` e NÃO cria nada quando a
 * routine do currículo está sem `bellSchedulesMapping`. Medido em 04/08/2026: a
 * routine `ENC` tem o mapeamento VAZIO, e por isso não existe um único slot no
 * currículo inteiro — e nenhuma frequência pode ser lançada no Toddle, nem por
 * nós, nem por um professor pela interface.
 *
 * POR QUE ALTERAR A ROUTINE EXISTENTE, E NÃO CRIAR UMA NOVA
 *
 * `POST /routine` restrito a Grade 6–12 é recusado com "Routine already exists for
 * selected grades for specified validity period": a `ENC` já detém essas séries em
 * toda a nossa janela, e uma série não pode estar em duas routines com vigências
 * sobrepostas. Todo caminho passa por esta routine.
 *
 * ─── ESTA OPERAÇÃO É IRREVERSÍVEL PELA API ──────────────────────────────────
 *
 * `bellScheduleMap: []` é recusado ("Invalid or missing Bell Schedule") e o campo
 * é obrigatório também no create. Logo o estado atual — mapeamento vazio — NÃO é
 * alcançável de volta: nem por update, nem apagando e recriando a routine. Dá
 * para trocar por outra grade depois; não para voltar a "nenhuma".
 *
 * ESCOPO, E O QUE ISSO ALCANÇA ALÉM DELE
 *
 * A `ENC` cobre as 15 séries do currículo. As 185 turma-disciplina em escopo são
 * só MS (114) e HS (71) — Grade 6 a 12. As outras 8 séries (Pre-K a Grade 5)
 * passarão a ter grade de horário na interface do Toddle. No DADO o efeito é
 * inerte: elas não têm turma nem slot no sync. Decisão da escola registrada em
 * 05/08/2026: infantil e Fund I não vão entrar, então esse alcance é aceitável.
 *
 * Uso:
 *   npm run seed:routine                 # plano, não escreve nada
 *   npm run seed:routine -- --executar   # aplica
 */

const ROUTINE_ID = '404046160261573423'; // "ENC", a única do currículo UBD

/**
 * Dias operacionais da organização, na convenção do TODDLE: 1 = segunda.
 *
 * O RM usa domingo=1 (segunda=2), então há um off-by-one entre os dois. Estes
 * valores foram descobertos por eliminação — o mapa tem de cobrir TODOS os dias
 * operacionais e só [1,2,3,4,5] passou; não há endpoint que os liste. A routine
 * `MYP`, que funciona, confirma: mapeamentos em weekday 1 a 5.
 */
const DIAS_OPERACIONAIS = [1, 2, 3, 4, 5];

/** Séries em escopo: MS (114 turma-disciplina) + HS (71). Pre-K a Grade 5 não entram. */
const SERIE_EM_ESCOPO = /^Grade (6|7|8|9|10|11|12)$/;

const LABEL_NOVO = 'EAV Campus 2 - Grade 6-12 (RM)';

/** Começo do ano letivo do RM (o ano acadêmico do Toddle começa em nov/2025). */
const INICIO_LETIVO = '2026-02-03';

const soData = (v: unknown): string => String(v ?? '').slice(0, 10);

async function main(): Promise<void> {
  const executar = process.argv.includes('--executar');
  await toddleClient.assertTargetOrganization();

  // ─── a grade que criamos ──────────────────────────────────────────────────
  const anos = await toddleClient.listAcademicYears();
  const atuais = anos.filter((a) => a.isCurrent === true);
  if (atuais.length !== 1) {
    throw new Error(`Esperava 1 ano acadêmico com isCurrent=true, achei ${atuais.length}.`);
  }
  const academicYearId = String((atuais[0] as Record<string, unknown>).id);

  const grades = await toddleClient.listBellSchedules([academicYearId]);
  const nossa = grades.filter((g) => String(g.label ?? '').includes('(RM)'));
  if (nossa.length !== 1) {
    throw new Error(
      `Esperava 1 bell schedule com "(RM)" no rótulo, achei ${nossa.length}` +
        `${nossa.length ? ` (${nossa.map((g) => g.label).join(', ')})` : ''}. ` +
        'Rode `npm run seed:periodos -- --executar` antes.',
    );
  }
  const bellScheduleId = String(nossa[0].id);
  const faixasDaGrade = (nossa[0].periodSet ?? []).length;

  // ─── a routine, como está ─────────────────────────────────────────────────
  const antes = await toddleClient.getRoutine(ROUTINE_ID);
  const mapaAtual = antes.bellSchedulesMapping ?? [];
  const series = antes.grades ?? [];

  const cursos = await idMappingRepository.listByType('COURSE', 'active');
  const emEscopo = series.filter((g) => SERIE_EM_ESCOPO.test(String(g.name ?? '')));
  const foraDeEscopo = series.filter((g) => !SERIE_EM_ESCOPO.test(String(g.name ?? '')));

  if (emEscopo.length !== 7) {
    throw new Error(
      `Esperava 7 séries de Grade 6 a 12 na routine, achei ${emEscopo.length}: ` +
        `${emEscopo.map((g) => g.name).join(', ')}`,
    );
  }

  const slots = await toddleClient.listTimetableSlots({
    curriculumId: String(antes.curriculumProgramId ?? ''),
    academicYearId,
    startDate: '2026-08-03',
    endDate: '2026-08-31',
  });

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Recriar a routine do currículo, agora com a grade ligada');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  APAGA:');
  console.log(`      ${ROUTINE_ID}  "${antes.label}"  ${series.length} séries`);
  console.log(`      vigência ${soData(antes.validity?.startDate)} → ${soData(antes.validity?.endDate)}`);
  console.log(`      bellSchedulesMapping: ${mapaAtual.length}  ← é isto que a torna inerte`);
  console.log(`      timetable slots que ela sustenta: ${slots.length}`);
  console.log('');
  console.log('  CRIA:');
  console.log(`      "${LABEL_NOVO}"`);
  console.log(`      ${emEscopo.length} séries: ${emEscopo.map((g) => g.name).join(', ')}`);
  console.log(`      vigência ${INICIO_LETIVO} → ${soData(antes.validity?.endDate)}`);
  console.log(`      grade ${bellScheduleId} "${nossa[0].label}" (${faixasDaGrade} faixas)`);
  console.log(`      dias ${DIAS_OPERACIONAIS.join(', ')} (1 = segunda, convenção do Toddle)`);
  console.log('');
  console.log(`  SAEM DE ESCOPO (${foraDeEscopo.length}): ${foraDeEscopo.map((g) => g.name).join(', ')}`);
  console.log('      Ficam sem routine no currículo — como já estão hoje na prática, porque');
  console.log('      a "ENC" tem mapeamento vazio e não produz grade para ninguém.');
  console.log('');
  console.log(`  turma-disciplina que passam a poder ter grade: ${cursos.length}`);
  console.log('');
  console.log('  Por que apagar e não editar: o PUT percorre os mapeamentos existentes lendo');
  console.log('  `.id`, e com zero mapeamentos estoura ("reading \'id\'"). bellScheduleMap é');
  console.log('  obrigatório no CREATE, então a routine nova nasce consistente.');
  console.log('');
  console.log('  ⚠ O DELETE não é reversível ao estado atual: recriar a "ENC" como está');
  console.log('    exigiria bellScheduleMap vazio, que a API recusa.');

  if (!executar) {
    console.log('\n  NADA FOI ESCRITO. --executar para aplicar.\n');
    return;
  }

  // Apaga a routine quebrada e cria uma nova JÁ com o mapeamento. É o único
  // caminho que funciona — ver §5.9 e §5.10 do doc.
  await toddleClient.deleteRoutine(ROUTINE_ID);
  logger.warn({ routineId: ROUTINE_ID, label: antes.label }, 'Routine apagada');

  const routineNova = await toddleClient.createRoutine({
    label: LABEL_NOVO,
    gradeIds: emEscopo.map((g) => String(g.id)),
    routineMode: 'OPERATIONAL_DAYS',
    startDate: INICIO_LETIVO,
    endDate: soData(antes.validity?.endDate),
    curriculumId: String(antes.curriculumProgramId ?? ''),
    academicYearId,
    countHolidayAsRotationDay: antes.countHolidayAsRotationDay ?? false,
    bellScheduleMap: DIAS_OPERACIONAIS.map((weekday) => ({ weekday, bellScheduleId })),
  });
  logger.info({ routineId: routineNova, label: LABEL_NOVO }, 'Routine criada');

  // ─── confere o que de fato ficou ──────────────────────────────────────────
  const depois = await toddleClient.getRoutine(routineNova);
  const mapaNovo = depois.bellSchedulesMapping ?? [];

  console.log('');
  console.log(`  routine              ${routineNova}  "${depois.label}"`);
  console.log(`  bellSchedulesMapping ${mapaAtual.length} → ${mapaNovo.length}`);
  console.log(`  séries               ${(depois.grades ?? []).length}: ` +
    `${(depois.grades ?? []).map((g) => g.name).join(', ')}`);
  console.log(`  vigência             ${soData(depois.validity?.startDate)} → ${soData(depois.validity?.endDate)}`);

  if (mapaNovo.length === 0) {
    logger.error(
      'O mapeamento saiu VAZIO — a routine nova nasceu com o mesmo defeito da "ENC". ' +
        'NÃO rode seed:timetable; investigue.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\n  ✓ mapeamento: ${JSON.stringify(mapaNovo).slice(0, 300)}`);
  console.log('\n  Próximo passo — a sonda dos slots (cria 1, lê de volta, aborta se falhar):');
  console.log('    npm run seed:timetable -- --executar --limite 3\n');
}

main()
  .catch((error) => {
    logger.error({ err: error }, 'seed:routine falhou');
    process.exitCode = 1;
  })
  .finally(() => pgPool.end());
