import { env, logger } from '@rm-toddle/config';
import { idMappingRepository, pgPool } from '@rm-toddle/db';
import { toddleClient } from '@rm-toddle/integrations';

/**
 * Cria no Toddle os períodos da grade de horário do RM, e a grade que os liga às
 * horas.
 *
 * POR QUE PRECISA EXISTIR
 *
 * A frequência lançada no Toddle não traz a hora da aula (medido em 04/08/2026:
 * `startTime` nulo em 800 de 800 registros). A hora vem do `periodSet` do bell
 * schedule. E as grades que existiam eram de DEMONSTRAÇÃO: 44 faixas em malha de
 * 15/30/45 minutos, contra as 7 do campus 2 — ZERO em comum. Sem isto, nenhum
 * lançamento do Toddle consegue apontar para uma aula do RM.
 *
 * IDEMPOTÊNCIA — leia antes de rodar duas vezes
 *
 * `POST /public/v2/period` NÃO aceita `sourceId`: o Toddle gera o dele. Então não
 * há como perguntar à API "o período da faixa 002 já existe?". A única defesa é o
 * de-para local (`id_mapping`, tipo `PERIOD`), que este script consulta ANTES de
 * criar. Se essas linhas forem perdidas, uma segunda execução cria períodos
 * duplicados e não há como distingui-los pela API.
 *
 * Uso:
 *   npm run seed:periodos                 # mostra o plano, não escreve nada
 *   npm run seed:periodos -- --executar   # cria
 *   npm run seed:periodos -- --remover    # desfaz (DELETE existe para período)
 */

/**
 * As 7 faixas da grade do campus 2, medidas em `EduHorarioTurmaData`.
 *
 * A chave é o sufixo do `CODHOR` do RM, que tem o formato `<dia><022><faixa>` e
 * mapeia 1:1 para (HORAINICIAL, HORAFINAL) — verificado nos 518 horários.
 *
 * A faixa 001, de 20 minutos, NÃO foi confirmada com a coordenação. Pelo formato
 * parece acolhida/homeroom, e no Toddle 49% da chamada é de homeroom — pode ser
 * o mesmo momento visto dos dois lados. O rótulo aqui é descritivo do horário, de
 * propósito: nomear de "Homeroom" seria afirmar o que não medimos.
 */
const FAIXAS = [
  { codHorSufixo: '001', inicio: '08:00', fim: '08:20' },
  { codHorSufixo: '002', inicio: '08:20', fim: '09:20' },
  { codHorSufixo: '003', inicio: '09:20', fim: '10:20' },
  { codHorSufixo: '004', inicio: '10:40', fim: '11:40' },
  { codHorSufixo: '005', inicio: '11:40', fim: '12:40' },
  { codHorSufixo: '006', inicio: '13:50', fim: '14:50' },
  { codHorSufixo: '007', inicio: '14:50', fim: '15:50' },
] as const;

/** Rótulo do período: identifica a origem e a faixa, sem afirmar pedagogia. */
const rotulo = (f: (typeof FAIXAS)[number]): string =>
  `RM ${f.codHorSufixo} (${f.inicio}-${f.fim})`;
const abreviacao = (f: (typeof FAIXAS)[number]): string => `R${Number(f.codHorSufixo)}`;

const ROTULO_GRADE = 'EAV Campus 2 - Fund II e Medio (RM)';

/** "08:00" → "08:00:00", formato que o bell schedule exige. */
const comSegundos = (hhmm: string): string => `${hhmm}:00`;

async function alvos(): Promise<{ curriculumId: string; academicYearId: string }> {
  // O currículo é o das NOSSAS turmas, não o dos year groups por acaso: é o
  // curriculumId que as 185 classes declaram.
  const cursos = await idMappingRepository.listByType('COURSE', 'active');
  if (cursos.length === 0) {
    throw new Error('Nenhum mapeamento COURSE ativo — sem turmas não há grade a criar.');
  }
  const nossos = new Set(cursos.map((c) => c.toddleId));
  const classes = (await toddleClient.listClasses()).filter((c) => nossos.has(String(c.id)));
  const curriculos = [...new Set(classes.map((c) => String(c.curriculumId ?? '')))].filter(Boolean);

  if (curriculos.length !== 1) {
    throw new Error(
      `As turmas em escopo declaram ${curriculos.length} currículos (${curriculos.join(', ')}). ` +
        'Um período pertence a UM currículo; com mais de um, a escolha é decisão da escola.',
    );
  }

  const anos = await toddleClient.listAcademicYears();
  const atuais = anos.filter((a) => a.isCurrent === true);
  if (atuais.length !== 1) {
    throw new Error(
      `Esperava exatamente 1 ano acadêmico com isCurrent=true, achei ${atuais.length}. ` +
        'Criar período no ano errado produz grade que a frequência nunca alcança.',
    );
  }

  return { curriculumId: curriculos[0], academicYearId: String(atuais[0].id) };
}

async function main(): Promise<void> {
  const executar = process.argv.includes('--executar');
  const remover = process.argv.includes('--remover');

  await toddleClient.assertTargetOrganization();
  const { curriculumId, academicYearId } = await alvos();

  const nomes = await toddleClient.listCurriculums();
  const curriculo = nomes.find((c) => String(c.id) === curriculumId);
  // `title` é o código do programa (UBD), `label` o nome de exibição. Não há `name`.
  const nomeCurriculo = curriculo
    ? `${curriculo.title ?? '?'} — ${curriculo.label ?? '?'}`
    : '(currículo não listado)';

  const jaMapeados = await idMappingRepository.listByType('PERIOD', 'active');
  const porFaixa = new Map(jaMapeados.map((m) => [m.rmCode, m]));

  logger.info(
    {
      curriculumId,
      curriculo: nomeCurriculo,
      attendanceVersion: curriculo?.attendanceVersion,
      timetableVersion: curriculo?.timetableVersion,
      academicYearId,
      organizacao: env.TODDLE_ORG_ID,
      jaMapeados: jaMapeados.length,
    },
    'Alvos resolvidos',
  );

  // ─── remoção ──────────────────────────────────────────────────────────────
  if (remover) {
    if (jaMapeados.length === 0) {
      logger.info('Nada mapeado — nada a remover.');
      return;
    }
    if (!executar) {
      console.log(`\nRemoveria ${jaMapeados.length} período(s):`);
      for (const m of jaMapeados) console.log(`  faixa ${m.rmCode} → periodId ${m.toddleId}`);
      console.log('\nAdicione --executar para remover de verdade.\n');
      return;
    }
    for (const m of jaMapeados) {
      await toddleClient.deletePeriod(m.toddleId);
      await idMappingRepository.markArchived('PERIOD', m.rmCode, 'removido por seed:periodos --remover');
      logger.info({ faixa: m.rmCode, periodId: m.toddleId }, 'Período removido');
    }
    logger.warn(
      'A GRADE (bell schedule) não é removida por este script: ela pode ter sido editada no ' +
        'portal. Remova pela UI ou por DELETE /bell-schedule/:id.',
    );
    return;
  }

  // ─── plano ────────────────────────────────────────────────────────────────
  const aCriar = FAIXAS.filter((f) => !porFaixa.has(f.codHorSufixo));

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  Períodos da grade do RM no Toddle');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  organização     ${env.TODDLE_ORG_ID}`);
  console.log(`  currículo       ${curriculumId}  "${nomeCurriculo}"`);
  console.log(`  ano acadêmico   ${academicYearId}  (isCurrent)`);
  console.log(`  grade           "${ROTULO_GRADE}"`);
  console.log('');
  for (const f of FAIXAS) {
    const existente = porFaixa.get(f.codHorSufixo);
    const marca = existente ? `já existe → periodId ${existente.toddleId}` : 'CRIAR';
    console.log(`  ${f.codHorSufixo}  ${f.inicio}-${f.fim}  ${abreviacao(f).padEnd(3)} "${rotulo(f)}"   ${marca}`);
  }
  console.log('');
  console.log(`  a criar: ${aCriar.length} de ${FAIXAS.length}`);

  if (!executar) {
    console.log('\n  NADA FOI ESCRITO. Adicione --executar para criar.\n');
    return;
  }

  // ─── criação ──────────────────────────────────────────────────────────────
  console.log('');
  for (const f of aCriar) {
    const criado = await toddleClient.createPeriod({
      label: rotulo(f),
      abbreviation: abreviacao(f),
      type: 'REGULAR',
      curriculumId,
      academicYearId,
    });
    // Grava o de-para IMEDIATAMENTE. Se o processo morrer entre o POST e o
    // upsert, o período fica órfão e indistinguível pela API — o Toddle não
    // aceita sourceId nosso. Uma linha por vez limita o dano a um período.
    await idMappingRepository.upsert({
      entityType: 'PERIOD',
      rmCode: f.codHorSufixo,
      toddleId: criado.id,
      rmInternalId: null,
    });
    logger.info({ faixa: f.codHorSufixo, periodId: criado.id, label: criado.label }, 'Período criado');
  }

  // A grade precisa de TODOS os 7, inclusive os que já existiam.
  const mapeados = await idMappingRepository.listByType('PERIOD', 'active');
  const idPorFaixa = new Map(mapeados.map((m) => [m.rmCode, m.toddleId]));
  const periodos = FAIXAS.map((f) => {
    const periodId = idPorFaixa.get(f.codHorSufixo);
    if (!periodId) throw new Error(`faixa ${f.codHorSufixo} sem periodId no de-para após a criação`);
    return { periodId, startTime: comSegundos(f.inicio), endTime: comSegundos(f.fim) };
  });

  const gradeId = await toddleClient.createBellSchedule({
    label: ROTULO_GRADE,
    curriculumId,
    academicYearId,
    periods: periodos,
  });
  logger.info({ bellScheduleId: gradeId, periodos: periodos.length }, 'Grade de horário criada');

  console.log('\n  Pronto. Rode o shadow mode para confirmar que as faixas agora se encontram:');
  console.log('    npm run shadow:frequencia -- --de 2026-03-02 --ate 2026-03-06\n');
}

main()
  .catch((error) => {
    logger.error({ err: error }, 'seed:periodos falhou');
    process.exitCode = 1;
  })
  .finally(() => pgPool.end());
