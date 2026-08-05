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

const ROUTINE_ID = '404046160261573423'; // "ENC", a única do currículo

/**
 * Dias operacionais da organização, na convenção do TODDLE: 1 = segunda.
 *
 * O RM usa domingo=1 (segunda=2), então há um off-by-one entre os dois. Estes
 * valores foram descobertos por eliminação — o mapa tem de cobrir TODOS os dias
 * operacionais e só [1,2,3,4,5] passou; não há endpoint que os liste.
 */
const DIAS_OPERACIONAIS = [1, 2, 3, 4, 5];

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

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Ligar a grade do RM à routine do currículo');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  routine          ${ROUTINE_ID}  "${antes.label}"`);
  console.log(`  modo             ${antes.routineMode}  (não vai no payload — não é alterável)`);
  console.log(`  vigência         ${soData(antes.validity?.startDate)} → ${soData(antes.validity?.endDate)}`);
  console.log(`  séries           ${series.length}  (preservadas como estão)`);
  console.log('');
  console.log(`  grade de horário ${bellScheduleId}  "${nossa[0].label}"  ${faixasDaGrade} faixas`);
  console.log(`  dias             ${DIAS_OPERACIONAIS.join(', ')}  (1 = segunda, convenção do Toddle)`);
  console.log('');
  console.log(`  bellSchedulesMapping AGORA:  ${mapaAtual.length} entrada(s)`);
  console.log(`  bellSchedulesMapping DEPOIS: ${DIAS_OPERACIONAIS.length} entrada(s)`);
  console.log('');
  console.log(`  turma-disciplina que passam a poder ter grade: ${cursos.length}`);
  console.log('');
  console.log('  ⚠ IRREVERSÍVEL PELA API. bellScheduleMap vazio é recusado, e o campo é');
  console.log('    obrigatório também no create — o estado atual não é alcançável de volta.');
  console.log('    Dá para trocar de grade depois; não para voltar a "nenhuma".');
  console.log('');
  console.log('  ⚠ ALCANÇA AS 15 SÉRIES desta routine, não só Grade 6-12. As 8 de fora');
  console.log('    (Pre-K a Grade 5) passam a mostrar grade na interface. No dado é inerte:');
  console.log('    não têm turma nem slot no sync, e por decisão da escola não vão entrar.');

  if (mapaAtual.length > 0) {
    console.log('');
    console.log(`  A routine JÁ TEM mapeamento: ${JSON.stringify(mapaAtual).slice(0, 300)}`);
    console.log('  Aplicar sobrescreveria. Confira se é o que você quer.');
  }

  if (!executar) {
    console.log('\n  NADA FOI ESCRITO. --executar para aplicar.\n');
    return;
  }

  // O payload reenvia os campos existentes SEM alterá-los: é substituição, não
  // remendo, e omitir um campo apaga configuração. O `label` fica "ENC" de
  // propósito — renomear seria uma segunda mudança não pedida.
  await toddleClient.updateRoutine(ROUTINE_ID, {
    label: String(antes.label ?? ''),
    gradeIds: series.map((g) => String(g.id)),
    startDate: soData(antes.validity?.startDate),
    endDate: soData(antes.validity?.endDate),
    countHolidayAsRotationDay: antes.countHolidayAsRotationDay ?? false,
    bellScheduleMap: DIAS_OPERACIONAIS.map((weekday) => ({ weekday, bellScheduleId })),
  });

  // ─── confere o que de fato mudou ──────────────────────────────────────────
  const depois = await toddleClient.getRoutine(ROUTINE_ID);
  const mapaNovo = depois.bellSchedulesMapping ?? [];

  console.log('');
  console.log(`  bellSchedulesMapping: ${mapaAtual.length} → ${mapaNovo.length}`);
  console.log(`  séries:               ${series.length} → ${(depois.grades ?? []).length}`);
  console.log(`  vigência:             ${soData(depois.validity?.startDate)} → ${soData(depois.validity?.endDate)}`);

  if ((depois.grades ?? []).length !== series.length) {
    logger.error(
      { antes: series.length, depois: (depois.grades ?? []).length },
      'As séries da routine MUDARAM — não era o esperado',
    );
  }
  if (mapaNovo.length === 0) {
    logger.error('O mapeamento continua vazio — o update não pegou. Investigue antes de seguir.');
    process.exitCode = 1;
    return;
  }

  console.log(`\n  ✓ mapeamento: ${JSON.stringify(mapaNovo).slice(0, 400)}`);
  console.log('\n  Próximo passo — a sonda dos slots (cria 1, lê de volta, aborta se falhar):');
  console.log('    npm run seed:timetable -- --executar --limite 3\n');
}

main()
  .catch((error) => {
    logger.error({ err: error }, 'seed:routine falhou');
    process.exitCode = 1;
  })
  .finally(() => pgPool.end());
