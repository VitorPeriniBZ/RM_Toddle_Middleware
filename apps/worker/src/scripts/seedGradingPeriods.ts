import { env, logger } from '@rm-toddle/config';
import { idMappingRepository, pgPool } from '@rm-toddle/db';
import { toddleClient } from '@rm-toddle/integrations';

/**
 * De-para entre a etapa de nota do RM e o grading period do Toddle.
 *
 *   npm run seed:gradingperiods                 # plano
 *   npm run seed:gradingperiods -- --executar   # grava
 *
 * Escreve APENAS no nosso banco (`id_mapping` tipo `GRADING_PERIOD`). Nada é
 * criado no Toddle — os períodos já existem lá e a API nem permite criá-los.
 *
 * ─── POR ORDINAL, E ISSO É UMA ESCOLHA ──────────────────────────────────────
 *
 * As janelas não correspondem (medido em 05/08/2026):
 *
 *   Toddle T1  21/11/2025 → 22/06/2026     RM etapa 1  03/02 → 15/05
 *   Toddle T2  23/06      → 22/09/2026     RM etapa 2  18/05 → 04/09
 *   Toddle T3  23/09      → 20/11/2026     RM etapa 3  09/09 → 11/12
 *
 * O T1 engloba o 1º trimestre do RM inteiro e um mês do 2º. Casar por data
 * misturaria etapas, então a escola decidiu (06/08/2026) casar por ORDEM.
 *
 * O script ordena os grading periods pela data de início e associa ao CODETAPA na
 * mesma ordem. Recusa se a contagem divergir — três etapas exigem três períodos.
 */

/** Etapas de NOTA do RM (TIPOETAPA='N'), na ordem do ano letivo. */
const ETAPAS_RM = ['1', '2', '3'];

const soData = (v: unknown): string => String(v ?? '').slice(0, 10);

async function main(): Promise<void> {
  const executar = process.argv.includes('--executar');
  await toddleClient.assertTargetOrganization();

  // O currículo das nossas turmas, não um chute.
  const cursos = await idMappingRepository.listByType('COURSE', 'active');
  const nossos = new Set(cursos.map((c) => c.toddleId));
  const classes = (await toddleClient.listClasses()).filter((c) => nossos.has(String(c.id)));
  const curriculos = [...new Set(classes.map((c) => String(c.curriculumId ?? '')))].filter(Boolean);
  if (curriculos.length !== 1) {
    throw new Error(`As turmas em escopo declaram ${curriculos.length} currículos.`);
  }
  const curriculumProgramId = curriculos[0];

  const periodos = (await toddleClient.listGradingPeriods(curriculumProgramId))
    .filter((p) => p.isCurrentAcademicYear !== false)
    .sort((a, b) => soData(a.startDate).localeCompare(soData(b.startDate)));

  if (periodos.length !== ETAPAS_RM.length) {
    throw new Error(
      `O RM tem ${ETAPAS_RM.length} etapas de nota e o Toddle devolveu ${periodos.length} ` +
        `grading period(s) no ano corrente (${periodos.map((p) => p.name).join(', ')}). ` +
        'O de-para por ordinal exige o mesmo número — pare e confira no portal.',
    );
  }

  const jaMapeados = await idMappingRepository.listByType('GRADING_PERIOD', 'active');
  const porEtapa = new Map(jaMapeados.map((m) => [m.rmCode, m]));

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Etapa de nota do RM → grading period do Toddle');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  currículo  ${curriculumProgramId}`);
  console.log('');
  console.log('  A correspondência é por ORDEM, não por data — as janelas divergem.');
  console.log('');
  for (const [i, etapa] of ETAPAS_RM.entries()) {
    const p = periodos[i];
    const existente = porEtapa.get(etapa);
    const marca = existente
      ? existente.toddleId === String(p.id)
        ? 'já mapeado'
        : `⚠ mapeado para OUTRO (${existente.toddleId})`
      : 'GRAVAR';
    console.log(`  etapa ${etapa}  →  ${p.name} "${p.label}"  ${p.id}`);
    console.log(`              Toddle: ${soData(p.startDate)} → ${soData(p.endDate)}   [${marca}]`);
  }

  const aGravar = ETAPAS_RM.filter((e, i) => porEtapa.get(e)?.toddleId !== String(periodos[i].id));
  console.log('');
  console.log(`  a gravar: ${aGravar.length} de ${ETAPAS_RM.length}`);

  if (!executar) {
    console.log('\n  NADA FOI GRAVADO. --executar para aplicar.');
    console.log('  (só escreve no nosso banco; o Toddle não é tocado)\n');
    return;
  }

  for (const [i, etapa] of ETAPAS_RM.entries()) {
    const p = periodos[i];
    await idMappingRepository.upsert({
      entityType: 'GRADING_PERIOD',
      rmCode: etapa,
      toddleId: String(p.id),
      rmInternalId: null,
    });
    logger.info({ etapa, gradingPeriodId: String(p.id), nome: p.name }, 'De-para de etapa gravado');
  }

  const depois = await idMappingRepository.listByType('GRADING_PERIOD', 'active');
  console.log(`\n  ✓ ${depois.length} de-para(s) ativo(s)\n`);
}

main()
  .catch((error) => {
    logger.error({ err: error }, 'seed:gradingperiods falhou');
    process.exitCode = 1;
  })
  .finally(() => pgPool.end());
