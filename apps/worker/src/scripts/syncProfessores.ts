import { logger } from '@rm-toddle/config';
import { idMappingRepository, pgPool } from '@rm-toddle/db';
import { fetchTeachersFromRm, type RmTeacher } from '@rm-toddle/domain';
import { comPaciencia, toddleClient } from '@rm-toddle/integrations';

/**
 * Sincroniza PROFESSORES do RM para o Toddle e vincula cada um às suas
 * turma-disciplina.
 *
 *   npm run sync:professores                          # plano, não escreve nada
 *   npm run sync:professores -- --executar --limite 2 # canário
 *   npm run sync:professores -- --executar            # o resto
 *
 * Diagnóstico completo (inclusive vínculo sobrando) em `reconciliar:professores`.
 *
 * ─── AS DUAS METADES TÊM RISCO DIFERENTE ────────────────────────────────────
 *
 * 1. **Criar staff é IRREVERSÍVEL.** `POST /staff` exige e-mail e o usa como
 *    IDENTIDADE; e-mail errado gera conta inacessível que só pode ser arquivada,
 *    nunca excluída. Por isso: professor sem e-mail no RM é PULADO e relatado —
 *    nunca inventado. E antes de criar, procura por e-mail no Toddle: se já
 *    existe, só grava o de-para (foi o caso do CODPROF 45).
 *
 * 2. **Vincular à turma é REVERSÍVEL** — existe `PUT /courses/:id/staffs/remove`.
 *    Então o vínculo pode ser automatizado com folga; errar não é definitivo.
 *
 * ─── O QUE ESTE SCRIPT NÃO FAZ ──────────────────────────────────────────────
 *
 * - **Não cria turma.** Turma-disciplina sem `COURSE` mapeado é relatada e
 *   pulada; criar Class é outra feature (exige teacherCourseId + curriculumId).
 * - **Não remove vínculo.** Staff que está na turma no Toddle e não no RM pode
 *   ser alocação da coordenação. Remover é decisão humana; o relatório aponta.
 * - **Não arquiva professor** que saiu do RM. Mesma razão.
 *
 * ─── IDEMPOTÊNCIA ───────────────────────────────────────────────────────────
 *
 * 1. `id_mapping` tipo `STAFF`, chaveado por `CODPROF`.
 * 2. `GET /staff` por e-mail, que recupera o vínculo se a camada 1 se perder.
 * 3. Vínculo: `GET /enrollments` diz o que já existe, então só o que falta é
 *    enviado. Rodar duas vezes não duplica nem re-vincula.
 */

const INTERVALO_MS = 250;
const dorme = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Papel com que o professor entra na turma. Resolvido por NOME, não fixo. */
const PAPEL_PROFESSOR = 'Class Teacher';

interface Plano {
  criarStaff: RmTeacher[];
  soMapearStaff: Array<{ prof: RmTeacher; staffId: string }>;
  semEmail: RmTeacher[];
  vincular: Array<{ classId: string; staffId: string; codProf: string; idTurmaDisc: string; rotulo: string }>;
  turmasNaoMapeadas: string[];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const executar = argv.includes('--executar');
  const iLimite = argv.indexOf('--limite');
  const limite = iLimite >= 0 ? Number(argv[iLimite + 1]) : Infinity;

  // Guarda de organização: escrever na org errada é o pior erro possível aqui.
  await toddleClient.assertTargetOrganization();

  const { professores, turmaDiscs } = await fetchTeachersFromRm();

  // roleId varia por organização — resolver por nome mantém o white label.
  const papeis = await toddleClient.listOrgRoles();
  const papel = papeis.find(
    (p) => p.roleLevel === 'CLASS' && p.roleName.trim().toLowerCase() === PAPEL_PROFESSOR.toLowerCase(),
  );
  if (!papel) {
    throw new Error(
      `Papel "${PAPEL_PROFESSOR}" (roleLevel=CLASS) não existe nesta organização. ` +
        `Disponíveis: ${papeis.filter((p) => p.roleLevel === 'CLASS').map((p) => p.roleName).join(', ')}`,
    );
  }
  logger.info({ papel: papel.roleName, roleId: papel.roleId }, 'Papel de professor resolvido');

  // --- estado atual ---
  const staffMap = await idMappingRepository.listByType('STAFF', 'active');
  const courseMap = await idMappingRepository.listByType('COURSE', 'active');
  const staffPorCodProf = new Map(staffMap.map((m) => [m.rmCode, m.toddleId]));
  const classPorTurmaDisc = new Map(courseMap.map((m) => [m.rmCode, m.toddleId]));

  const staffNoToddle = new Map<string, string>(); // email -> staffId
  for (let pagina = 1; pagina <= 20; pagina += 1) {
    const lote = await toddleClient.listStaffPage(pagina);
    if (lote.length === 0) break;
    for (const s of lote) {
      const email = String(s.email ?? '').trim().toLowerCase();
      if (email) staffNoToddle.set(email, String(s.id ?? ''));
    }
  }

  // Vínculos existentes: uma consulta paginada, não uma por turma (ver
  // comPaciencia e a nota de rate limit em DECISOES.md).
  const enrollments = await toddleClient.listEnrollments();
  const staffPorClass = new Map<string, Set<string>>();
  for (const e of enrollments) {
    if (String(e.type ?? '') !== 'staff' || e.isClassArchived === true) continue;
    const c = String(e.courseId ?? '');
    if (!c) continue;
    if (!staffPorClass.has(c)) staffPorClass.set(c, new Set());
    staffPorClass.get(c)!.add(String(e.userId ?? ''));
  }

  // --- monta o plano ---
  const plano: Plano = { criarStaff: [], soMapearStaff: [], semEmail: [], vincular: [], turmasNaoMapeadas: [] };

  for (const prof of professores.values()) {
    if (!prof.email) { plano.semEmail.push(prof); continue; }
    if (staffPorCodProf.has(prof.codProf)) continue; // já mapeado
    const existente = staffNoToddle.get(prof.email.toLowerCase());
    if (existente) plano.soMapearStaff.push({ prof, staffId: existente });
    else plano.criarStaff.push(prof);
  }

  for (const td of turmaDiscs.values()) {
    const classId = classPorTurmaDisc.get(td.idTurmaDisc);
    if (!classId) { plano.turmasNaoMapeadas.push(td.idTurmaDisc); continue; }
    const jaNaTurma = staffPorClass.get(classId) ?? new Set<string>();

    for (const codProf of td.codProfs) {
      const prof = professores.get(codProf);
      if (!prof?.email) continue; // sem e-mail não haverá staff para vincular

      // O staffId pode vir do de-para OU do plano desta execução.
      const staffId =
        staffPorCodProf.get(codProf) ??
        plano.soMapearStaff.find((x) => x.prof.codProf === codProf)?.staffId;

      // Quem será criado agora ainda não tem id: fica para a próxima execução.
      // Preferi isso a adivinhar ordem de dependência dentro do mesmo run.
      if (!staffId) continue;
      if (jaNaTurma.has(staffId)) continue;

      plano.vincular.push({
        classId, staffId, codProf,
        idTurmaDisc: td.idTurmaDisc,
        rotulo: `${td.codTurma}/${td.nomeDisciplina}`,
      });
    }
  }

  logger.info(
    {
      criarStaff: plano.criarStaff.length,
      soMapearStaff: plano.soMapearStaff.length,
      semEmail: plano.semEmail.length,
      vincular: plano.vincular.length,
      turmasNaoMapeadas: plano.turmasNaoMapeadas.length,
      modo: executar ? 'EXECUTAR' : 'ensaio (nada será escrito)',
      limite: Number.isFinite(limite) ? limite : 'sem limite',
    },
    'Plano do sync de professores',
  );

  for (const p of plano.semEmail) {
    logger.warn(
      { codProf: p.codProf, nome: p.nome, turmaDiscs: p.turmaDiscIds.length },
      'PULADO: sem e-mail no RM — secretaria precisa cadastrar; POST /staff exige e-mail e ele é a identidade',
    );
  }
  for (const x of plano.soMapearStaff) {
    logger.info({ codProf: x.prof.codProf, nome: x.prof.nome, staffId: x.staffId }, 'só gravar de-para (já existe no Toddle)');
  }
  for (const p of plano.criarStaff) {
    logger.info({ codProf: p.codProf, nome: p.nome, email: p.email }, 'criar staff');
  }
  for (const v of plano.vincular.slice(0, 30)) {
    logger.info({ idTurmaDisc: v.idTurmaDisc, codProf: v.codProf }, `vincular em ${v.rotulo}`);
  }
  if (plano.vincular.length > 30) logger.info(`... e mais ${plano.vincular.length - 30} vínculos`);

  if (!executar) {
    logger.info('ENSAIO — nada foi escrito. Rode com --executar (e --limite N para canário).');
    await pgPool.end();
    return;
  }

  // ---------------------------------------------------------------- escrita
  let mapeados = 0;
  let criados = 0;
  let vinculados = 0;
  const falhas: Array<{ o_que: string; alvo: string; erro: string }> = [];

  // 1. De-para de quem já existe no Toddle. Nenhuma escrita remota, então não
  //    consome do limite e não entra no --limite.
  for (const { prof, staffId } of plano.soMapearStaff) {
    await idMappingRepository.upsert({ entityType: 'STAFF', rmCode: prof.codProf, toddleId: staffId });
    mapeados += 1;
    logger.info({ codProf: prof.codProf, staffId }, 'de-para gravado');
  }

  // 2. Criar staff. O de-para é gravado IMEDIATAMENTE após cada POST: se o
  //    processo morrer no meio, a próxima execução não recria.
  for (const prof of plano.criarStaff.slice(0, limite)) {
    const [primeiro, ...resto] = prof.nome.split(/\s+/);
    try {
      const criado = await comPaciencia(() =>
        toddleClient.createStaff({
          firstName: primeiro ?? prof.nome,
          lastName: resto.join(' ') || primeiro || prof.nome,
          email: prof.email,
          sourceId: prof.codProf,
        }),
      );
      const staffId = String((criado.id as string) ?? (criado.staffId as string) ?? '');
      if (!staffId) throw new Error(`Toddle não devolveu id: ${JSON.stringify(criado).slice(0, 200)}`);
      await idMappingRepository.upsert({ entityType: 'STAFF', rmCode: prof.codProf, toddleId: staffId });
      criados += 1;
      staffPorCodProf.set(prof.codProf, staffId);
      logger.info({ codProf: prof.codProf, staffId, nome: prof.nome }, 'staff criado e mapeado');
    } catch (error) {
      falhas.push({ o_que: 'criar staff', alvo: `${prof.codProf} ${prof.nome}`, erro: (error as Error).message });
      logger.error({ codProf: prof.codProf, error }, 'falha ao criar staff');
    }
    await dorme(INTERVALO_MS);
  }

  // 3. Vínculos. Agrupados por turma: o endpoint aceita um array, então uma
  //    chamada por turma em vez de uma por professor — 70 das 202 turmas têm
  //    mais de um docente.
  const porTurma = new Map<string, typeof plano.vincular>();
  for (const v of plano.vincular) {
    if (!porTurma.has(v.classId)) porTurma.set(v.classId, []);
    porTurma.get(v.classId)!.push(v);
  }

  for (const [classId, lista] of [...porTurma.entries()].slice(0, limite)) {
    try {
      await comPaciencia(() =>
        toddleClient.addStaffToClass(
          classId,
          lista.map((v) => ({ id: v.staffId, roleId: papel.roleId })),
        ),
      );
      vinculados += lista.length;
      logger.info(
        { classId, quantos: lista.length, turma: lista[0]?.rotulo },
        'professores vinculados à turma',
      );
    } catch (error) {
      falhas.push({ o_que: 'vincular', alvo: lista[0]?.rotulo ?? classId, erro: (error as Error).message });
      logger.error({ classId, error }, 'falha ao vincular');
    }
    await dorme(INTERVALO_MS);
  }

  logger.info(
    { mapeados, criados, vinculados, falhas: falhas.length, pulados_sem_email: plano.semEmail.length },
    falhas.length === 0 ? 'Sync de professores concluído' : 'Sync concluído COM FALHAS',
  );
  for (const f of falhas) logger.error(f, 'falha');

  await pgPool.end();
}

main().catch((error) => {
  logger.error({ error }, 'Falha no sync de professores');
  process.exit(1);
});
