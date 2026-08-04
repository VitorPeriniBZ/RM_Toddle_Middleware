import { env, logger } from '@rm-toddle/config';
import { idMappingRepository, pgPool } from '@rm-toddle/db';
import { diaSemanaRm, RmAttendanceTargets, type RmHorario } from '@rm-toddle/domain';
import { toddleClient } from '@rm-toddle/integrations';

/**
 * Espelha a grade de horário do RM (`SHorarioTurma`) como timetable slots no
 * Toddle.
 *
 * POR QUE PRECISA EXISTIR
 *
 * O Toddle valida a frequência contra o slot: sem ele, `POST /attendance` recusa
 * com "Attendance Record is not valid". Isso não é peculiaridade da nossa
 * integração — sem os slots, professor nenhum consegue lançar chamada por
 * disciplina no Toddle. São três níveis, e este é o terceiro:
 *
 *   período        →  o que é uma "aula 2"          (seed:periodos)
 *   bell schedule  →  a que hora a "aula 2" começa  (seed:periodos)
 *   timetable slot →  qual turma tem aula 2 na segunda   (ESTE)
 *
 * O QUE ESTE SCRIPT NÃO CONSEGUE GARANTIR
 *
 * `POST /timetable-slots` devolve só `{ isSuccess: true }`, SEM id, e NÃO existe
 * DELETE. Então:
 *
 *  - não há de-para slot ↔ IDHORARIOTURMA para guardar; a identificação é a
 *    tupla (courseId, periodId, weekDay), recuperada pelo GET;
 *  - a idempotência vem de consultar o GET ANTES de criar. É melhor que em
 *    seed:periodos (onde só o de-para local protege), mas depende de o GET
 *    devolver o slot na janela consultada;
 *  - cada criação é permanente. Não há desfazer.
 *
 * Uso:
 *   npm run seed:timetable                 # plano, não escreve nada
 *   npm run seed:timetable -- --executar   # cria
 *   npm run seed:timetable -- --executar --limite 5   # cria só os N primeiros
 */

/** Fim do ano acadêmico do Toddle. Vem da API, não é constante — ver `alvos()`. */
interface Alvos {
  curriculumId: string;
  academicYearId: string;
  ayInicio: string;
  ayFim: string;
}

interface SlotPlanejado {
  horario: RmHorario;
  courseId: string;
  periodId: string;
  weekDay: number;
  applicableFrom?: string;
  applicableTill?: string;
  /** Vigência do RM foi limitada ao fim do ano acadêmico do Toddle. */
  limitado: boolean;
  /** O horário do RM não tem vigência (8 casos medidos). */
  semVigencia: boolean;
}

const soData = (v: string): string => v.slice(0, 10);

/**
 * DIASEMANA do RM → weekday do Toddle. É um OFF-BY-ONE, medido em 04/08/2026.
 *
 * O RM usa domingo=1, logo segunda=2 … sexta=6.
 * O Toddle usa segunda=1 … sexta=5. Descoberto por eliminação: `POST /routine`
 * só aceita `bellScheduleMap` cobrindo TODOS os dias operacionais, e o conjunto
 * que passou a validação foi [1,2,3,4,5] — os outros (1..7, 2..7, 0..6, 2..6)
 * foram recusados com "must include all operational days".
 *
 * ATENÇÃO: isso está provado para `bellScheduleMap.weekday`. Que
 * `timetable-slots.weekDay` use a MESMA convenção é suposição — é justamente o
 * que a sonda confere, comparando a data que o GET devolve com o dia pedido.
 */
const weekDayToddle = (diaSemanaRmValor: string): number => Number(diaSemanaRmValor) - 1;

async function alvos(): Promise<Alvos> {
  const cursos = await idMappingRepository.listByType('COURSE', 'active');
  if (cursos.length === 0) throw new Error('Nenhum mapeamento COURSE ativo.');

  const nossos = new Set(cursos.map((c) => c.toddleId));
  const classes = (await toddleClient.listClasses()).filter((c) => nossos.has(String(c.id)));
  const curriculos = [...new Set(classes.map((c) => String(c.curriculumId ?? '')))].filter(Boolean);
  if (curriculos.length !== 1) {
    throw new Error(
      `As turmas em escopo declaram ${curriculos.length} currículos (${curriculos.join(', ')}). ` +
        'Um slot pertence a UM currículo.',
    );
  }

  const anos = await toddleClient.listAcademicYears();
  const atuais = anos.filter((a) => a.isCurrent === true);
  if (atuais.length !== 1) {
    throw new Error(`Esperava 1 ano acadêmico com isCurrent=true, achei ${atuais.length}.`);
  }
  const ay = atuais[0] as Record<string, unknown>;
  const inicio = soData(String(ay.start_date ?? ay.startDate ?? ''));
  const fim = soData(String(ay.end_date ?? ay.endDate ?? ''));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inicio) || !/^\d{4}-\d{2}-\d{2}$/.test(fim)) {
    throw new Error(`Não consegui ler a vigência do ano acadêmico: ${JSON.stringify(ay)}`);
  }

  return { curriculumId: curriculos[0], academicYearId: String(ay.id), ayInicio: inicio, ayFim: fim };
}

/**
 * Semanas de sondagem para a idempotência.
 *
 * O GET devolve os slots expandidos por data, então basta uma janela que contenha
 * uma ocorrência de cada slot. Uma semana no começo e uma no fim do período letivo
 * cobrem também os 32 horários de vigência parcial (11 terminam em 24/04, 11
 * começam em 27/04).
 */
const SEMANAS_SONDA = [
  { startDate: '2026-03-02', endDate: '2026-03-06' },
  { startDate: '2026-08-03', endDate: '2026-08-07' },
  { startDate: '2026-11-09', endDate: '2026-11-13' },
] as const;

const chaveSlot = (courseId: string, periodId: string, weekDay: number | string): string =>
  `${courseId}|${periodId}|${weekDay}`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const executar = argv.includes('--executar');
  const iLimite = argv.indexOf('--limite');
  const limite = iLimite >= 0 ? Number(argv[iLimite + 1]) : Infinity;

  await toddleClient.assertTargetOrganization();
  const alvo = await alvos();

  const cursos = await idMappingRepository.listByType('COURSE', 'active');
  const periodos = await idMappingRepository.listByType('PERIOD', 'active');
  if (periodos.length === 0) {
    throw new Error(
      'Nenhum período mapeado. Rode `npm run seed:periodos -- --executar` antes: um slot ' +
        'precisa de periodId, e o de-para faixa → periodId vive na id_mapping.',
    );
  }

  const courseIdPorTd = new Map(cursos.map((c) => [c.rmCode, c.toddleId]));
  // O de-para PERIOD é por faixa (sufixo do CODHOR); a chave aqui é a hora, que
  // é o que o horário do RM carrega.
  const faixaPorHora = new Map<string, string>([
    ['08:00', '001'], ['08:20', '002'], ['09:20', '003'], ['10:40', '004'],
    ['11:40', '005'], ['13:50', '006'], ['14:50', '007'],
  ]);
  const periodIdPorFaixa = new Map(periodos.map((p) => [p.rmCode, p.toddleId]));

  const alvosRm = await RmAttendanceTargets.carregar(cursos.map((c) => c.rmCode), env.RM_CODFILIAL);
  const horarios = alvosRm.todosHorarios();

  // ─── planeja ──────────────────────────────────────────────────────────────
  const planejados: SlotPlanejado[] = [];
  const semPeriodo: RmHorario[] = [];
  const semCurso: RmHorario[] = [];

  for (const h of horarios) {
    const courseId = courseIdPorTd.get(h.idTurmaDisc);
    if (!courseId) { semCurso.push(h); continue; }
    const faixa = faixaPorHora.get(h.horaInicial);
    const periodId = faixa ? periodIdPorFaixa.get(faixa) : undefined;
    if (!periodId) { semPeriodo.push(h); continue; }

    const from = h.dataInicial && h.dataInicial >= alvo.ayInicio ? h.dataInicial : undefined;
    const tillBruto = h.dataFinal ?? undefined;
    const limitado = Boolean(tillBruto && tillBruto > alvo.ayFim);
    const till = tillBruto ? (limitado ? alvo.ayFim : tillBruto) : undefined;

    planejados.push({
      horario: h,
      courseId,
      periodId,
      weekDay: weekDayToddle(h.diaSemana),
      applicableFrom: from,
      applicableTill: till,
      limitado,
      semVigencia: !h.dataInicial || !h.dataFinal,
    });
  }

  // ─── o que já existe ──────────────────────────────────────────────────────
  const existentes = new Set<string>();
  for (const semana of SEMANAS_SONDA) {
    const slots = await toddleClient.listTimetableSlots({
      curriculumId: alvo.curriculumId,
      academicYearId: alvo.academicYearId,
      ...semana,
    });
    for (const s of slots) {
      if (s.courseId && s.periodId && s.weekday !== undefined) {
        existentes.add(chaveSlot(String(s.courseId), String(s.periodId), s.weekday));
      }
    }
  }

  const aCriar = planejados.filter(
    (p) => !existentes.has(chaveSlot(p.courseId, p.periodId, p.weekDay)),
  );
  const limitados = planejados.filter((p) => p.limitado).length;

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Grade do RM → timetable slots do Toddle');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  currículo       ${alvo.curriculumId}`);
  console.log(`  ano acadêmico   ${alvo.academicYearId}  ${alvo.ayInicio} → ${alvo.ayFim}`);
  console.log('');
  console.log(`  horários no RM (em escopo)      ${horarios.length}`);
  console.log(`  planejáveis                    ${planejados.length}`);
  if (semCurso.length) console.log(`  ⚠ sem turma mapeada             ${semCurso.length}`);
  if (semPeriodo.length) {
    const faixasOrfas = [...new Set(semPeriodo.map((h) => `${h.horaInicial}-${h.horaFinal}`))];
    console.log(`  ⚠ sem período no Toddle         ${semPeriodo.length}  (${faixasOrfas.join(', ')})`);
  }
  console.log(`  já existem no Toddle           ${planejados.length - aCriar.length}`);
  console.log(`  A CRIAR                        ${aCriar.length}`);
  console.log('');
  if (limitados) {
    console.log(`  ⚠ ${limitados} slot(s) com vigência LIMITADA ao fim do ano acadêmico`);
    console.log(`    O ano letivo do RM passa de ${alvo.ayFim}. As aulas depois dessa data NÃO`);
    console.log('    terão grade no Toddle, logo não aceitarão chamada lá. Decisão de');
    console.log('    calendário da escola — este script não a resolve, só a torna visível.');
    console.log('');
  }
  const semVig = planejados.filter((p) => p.semVigencia).length;
  if (semVig) {
    console.log(`  ${semVig} slot(s) sem vigência no RM: irão sem applicableFrom/Till`);
    console.log('');
  }

  const porDia = new Map<number, number>();
  for (const p of aCriar) porDia.set(p.weekDay, (porDia.get(p.weekDay) ?? 0) + 1);
  console.log('  a criar por weekday do TODDLE (1=segunda):',
    JSON.stringify(Object.fromEntries([...porDia].sort())));

  if (!executar) {
    console.log('\n  NADA FOI ESCRITO. --executar para criar.');
    console.log('  ATENÇÃO: não existe DELETE de timetable-slot na API. É permanente.\n');
    return;
  }
  if (aCriar.length === 0) {
    console.log('\n  Nada a criar.\n');
    return;
  }

  // ─── SONDA: um slot, lido de volta, antes dos outros 517 ───────────────────
  //
  // O `weekDay` é a única suposição do payload: o RM usa domingo=1 (logo
  // segunda=2) e o exemplo da API mostra weekday=2 em aulas. Se a convenção
  // divergir, os 518 slots caem no dia errado — e não há DELETE. Então criamos
  // UM, lemos de volta, e conferimos que a data devolvida cai no dia que
  // pedimos. Só então seguimos.
  const sonda = aCriar[0];
  logger.info(
    {
      idHorarioTurma: sonda.horario.idHorarioTurma,
      courseId: sonda.courseId,
      weekDay: sonda.weekDay,
      hora: sonda.horario.horaInicial,
    },
    'Criando o slot de SONDA para conferir a convenção de weekDay',
  );

  await toddleClient.createTimetableSlot({
    curriculumId: alvo.curriculumId,
    academicYearId: alvo.academicYearId,
    courseId: sonda.courseId,
    weekDay: sonda.weekDay,
    periodId: sonda.periodId,
    startTime: `${sonda.horario.horaInicial}:00`,
    endTime: `${sonda.horario.horaFinal}:00`,
    ...(sonda.applicableFrom ? { applicableFrom: sonda.applicableFrom } : {}),
    ...(sonda.applicableTill ? { applicableTill: sonda.applicableTill } : {}),
    isEnabled: true,
  });

  const lidos = await toddleClient.listTimetableSlots({
    curriculumId: alvo.curriculumId,
    academicYearId: alvo.academicYearId,
    startDate: '2026-08-03',
    endDate: '2026-08-07',
    courseIds: [sonda.courseId],
  });
  const daSonda = lidos.filter(
    (s) => String(s.periodId) === sonda.periodId && Number(s.weekday) === sonda.weekDay,
  );

  if (daSonda.length === 0) {
    throw new Error(
      'A sonda foi criada mas o GET não a devolveu na semana de 03–07/08. Pare e investigue ' +
        'antes de criar os outros — não há DELETE para corrigir em massa.',
    );
  }

  // A data devolvida é conferida contra o dia do RM, convertendo de volta: se o
  // Toddle materializou a ocorrência noutro dia, a convenção divergiu.
  const datasErradas = daSonda
    .map((s) => String(s.date ?? '').slice(0, 10))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .filter((d) => diaSemanaRm(d) !== String(sonda.weekDay + 1));

  if (datasErradas.length > 0) {
    throw new Error(
      `CONVENÇÃO DE weekDay ERRADA: pedi weekDay=${sonda.weekDay} e o Toddle devolveu ` +
        `ocorrência(s) em ${datasErradas.join(', ')}, que não é esse dia. ABORTANDO antes dos ` +
        'outros slots. O slot da sonda ficou criado no dia errado e não há DELETE — ' +
        'corrija pelo portal.',
    );
  }

  logger.info(
    { ocorrencias: daSonda.length, datas: daSonda.map((s) => s.date).slice(0, 5) },
    'Sonda conferida: a convenção de weekDay está correta',
  );

  // ─── os demais ────────────────────────────────────────────────────────────
  const restantes = aCriar.slice(1, Number.isFinite(limite) ? limite : undefined);
  let criados = 1;
  let falhas = 0;

  for (const p of restantes) {
    try {
      await toddleClient.createTimetableSlot({
        curriculumId: alvo.curriculumId,
        academicYearId: alvo.academicYearId,
        courseId: p.courseId,
        weekDay: p.weekDay,
        periodId: p.periodId,
        startTime: `${p.horario.horaInicial}:00`,
        endTime: `${p.horario.horaFinal}:00`,
        ...(p.applicableFrom ? { applicableFrom: p.applicableFrom } : {}),
        ...(p.applicableTill ? { applicableTill: p.applicableTill } : {}),
        isEnabled: true,
      });
      criados += 1;
      if (criados % 50 === 0) {
        logger.info({ criados, de: Math.min(aCriar.length, limite) }, 'progresso');
      }
    } catch (error) {
      falhas += 1;
      logger.error(
        {
          err: error,
          idHorarioTurma: p.horario.idHorarioTurma,
          courseId: p.courseId,
          weekDay: p.weekDay,
        },
        'Slot falhou — seguindo com os próximos',
      );
      // Um teto de falhas evita insistir 500 vezes contra um erro sistêmico.
      if (falhas >= 10) {
        throw new Error(`${falhas} falhas — abortando. Investigue antes de continuar.`);
      }
    }
  }

  console.log(`\n  criados: ${criados}   falhas: ${falhas}`);
  console.log('\n  Confira e rode o shadow mode:');
  console.log('    npm run shadow:frequencia -- --de 2026-08-03 --ate 2026-08-07\n');
}

main()
  .catch((error) => {
    logger.error({ err: error }, 'seed:timetable falhou');
    process.exitCode = 1;
  })
  .finally(() => pgPool.end());
