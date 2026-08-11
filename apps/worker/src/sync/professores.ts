import { logger } from '@rm-toddle/config';
import { idMappingRepository } from '@rm-toddle/db';
import { fetchTeachersFromRm, type RmTeacher } from '@rm-toddle/domain';
import { comPaciencia, toddleClient } from '@rm-toddle/integrations';

/**
 * Sincronização de PROFESSOR e do vínculo turma-disciplina↔docente.
 *
 * Mora aqui, e não no script, porque DOIS chamadores a usam: o CLI
 * (`npm run sync:professores`, com ensaio e canário) e o job noturno do BullMQ
 * (`staff.sync`). Duplicar a lógica faria os dois divergirem.
 *
 * NÃO fecha o pool do Postgres — quem chama gerencia o ciclo de vida. O script
 * encerra o processo; o worker segue vivo para o próximo job.
 *
 * ─── AS DUAS METADES TÊM RISCO DIFERENTE ────────────────────────────────────
 *
 * 1. **Criar staff é IRREVERSÍVEL.** `POST /staff` exige e-mail e o usa como
 *    IDENTIDADE; e-mail errado gera conta inacessível que só pode ser arquivada.
 *    Professor sem e-mail é PULADO e relatado — nunca inventado. E antes de
 *    criar, procura por e-mail no Toddle: se já existe, só grava o de-para.
 * 2. **Vincular à turma é REVERSÍVEL** (`PUT /courses/:id/staffs/remove`).
 *
 * ─── O QUE NÃO FAZ, DE PROPÓSITO ────────────────────────────────────────────
 *
 * Não cria turma, não remove vínculo (staff a mais pode ser alocação da
 * coordenação) e não arquiva professor que saiu. As três são decisão humana;
 * `reconciliar:professores` aponta.
 */

const INTERVALO_MS = 250;
const dorme = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Papel com que o professor entra na turma. Resolvido por NOME, não fixo. */
const PAPEL_PROFESSOR = 'Class Teacher';

export interface OpcoesSyncProfessores {
  /** `false` = ensaio: monta o plano, loga e não escreve nada. */
  executar: boolean;
  /** Teto de POSTs de staff e de turmas vinculadas (canário). */
  limite?: number;
}

export interface ResumoSyncProfessores {
  mapeados: number;
  criados: number;
  vinculados: number;
  pulados_sem_email: number;
  turmas_nao_mapeadas: number;
  falhas: Array<{ o_que: string; alvo: string; erro: string }>;
}

export async function sincronizarProfessores(
  opcoes: OpcoesSyncProfessores,
): Promise<ResumoSyncProfessores> {
  const { executar } = opcoes;
  const limite = opcoes.limite ?? Infinity;

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

  // Uma consulta paginada, não uma por turma: 186 chamadas estouraram o rate
  // limit (janela de 300s). Ver DECISOES.md.
  const enrollments = await toddleClient.listEnrollments();
  const staffPorClass = new Map<string, Set<string>>();
  for (const e of enrollments) {
    if (String(e.type ?? '') !== 'staff' || e.isClassArchived === true) continue;
    const c = String(e.courseId ?? '');
    if (!c) continue;
    if (!staffPorClass.has(c)) staffPorClass.set(c, new Set());
    staffPorClass.get(c)!.add(String(e.userId ?? ''));
  }

  // --- plano ---
  const criarStaff: RmTeacher[] = [];
  const soMapearStaff: Array<{ prof: RmTeacher; staffId: string }> = [];
  const semEmail: RmTeacher[] = [];
  const vincular: Array<{ classId: string; staffId: string; codProf: string; idTurmaDisc: string; rotulo: string }> = [];
  const turmasNaoMapeadas: string[] = [];

  for (const prof of professores.values()) {
    if (!prof.email) { semEmail.push(prof); continue; }
    if (staffPorCodProf.has(prof.codProf)) continue;
    const existente = staffNoToddle.get(prof.email.toLowerCase());
    if (existente) soMapearStaff.push({ prof, staffId: existente });
    else criarStaff.push(prof);
  }

  for (const td of turmaDiscs.values()) {
    const classId = classPorTurmaDisc.get(td.idTurmaDisc);
    if (!classId) { turmasNaoMapeadas.push(td.idTurmaDisc); continue; }
    const jaNaTurma = staffPorClass.get(classId) ?? new Set<string>();

    for (const codProf of td.codProfs) {
      const prof = professores.get(codProf);
      if (!prof?.email) continue;

      const staffId =
        staffPorCodProf.get(codProf) ??
        soMapearStaff.find((x) => x.prof.codProf === codProf)?.staffId;

      // Quem será criado agora ainda não tem id: o vínculo fica para a próxima
      // execução, em vez de eu adivinhar ordem de dependência no mesmo run.
      if (!staffId || jaNaTurma.has(staffId)) continue;

      vincular.push({
        classId, staffId, codProf,
        idTurmaDisc: td.idTurmaDisc,
        rotulo: `${td.codTurma}/${td.nomeDisciplina}`,
      });
    }
  }

  logger.info(
    {
      criarStaff: criarStaff.length,
      soMapearStaff: soMapearStaff.length,
      semEmail: semEmail.length,
      vincular: vincular.length,
      turmasNaoMapeadas: turmasNaoMapeadas.length,
      papel: papel.roleName,
      modo: executar ? 'EXECUTAR' : 'ensaio (nada será escrito)',
    },
    'Plano do sync de professores',
  );

  // Sem e-mail é WARN sempre, inclusive no job noturno: é pendência de dado da
  // escola e a única forma de ela aparecer.
  for (const p of semEmail) {
    logger.warn(
      { codProf: p.codProf, nome: p.nome, turmaDiscs: p.turmaDiscIds.length },
      'PULADO: sem e-mail no RM — secretaria precisa cadastrar; POST /staff exige e-mail e ele é a identidade',
    );
  }

  const resumo: ResumoSyncProfessores = {
    mapeados: 0, criados: 0, vinculados: 0,
    pulados_sem_email: semEmail.length,
    turmas_nao_mapeadas: turmasNaoMapeadas.length,
    falhas: [],
  };

  if (!executar) {
    for (const x of soMapearStaff) logger.info({ codProf: x.prof.codProf, staffId: x.staffId }, 'só gravar de-para (já existe no Toddle)');
    for (const p of criarStaff) logger.info({ codProf: p.codProf, email: p.email }, 'criar staff');
    for (const v of vincular.slice(0, 30)) logger.info({ idTurmaDisc: v.idTurmaDisc, codProf: v.codProf }, `vincular em ${v.rotulo}`);
    if (vincular.length > 30) logger.info(`... e mais ${vincular.length - 30} vínculos`);
    logger.info('ENSAIO — nada foi escrito.');
    return resumo;
  }

  // ---------------------------------------------------------------- escrita
  // 1. De-para de quem já existe no Toddle: nenhuma escrita remota, então fora
  //    do --limite.
  for (const { prof, staffId } of soMapearStaff) {
    await idMappingRepository.upsert({ entityType: 'STAFF', rmCode: prof.codProf, toddleId: staffId });
    resumo.mapeados += 1;
    staffPorCodProf.set(prof.codProf, staffId);
    logger.info({ codProf: prof.codProf, staffId }, 'de-para gravado');
  }

  // 2. Criar staff. De-para gravado IMEDIATAMENTE após cada POST: morrer no
  //    meio não faz a próxima execução recriar.
  for (const prof of criarStaff.slice(0, limite)) {
    const [primeiro, ...resto] = prof.nome.split(/\s+/);
    try {
      // `createStaff` já extrai e valida o id (a resposta o aninha em `staff`).
      const staffId = await comPaciencia(() =>
        toddleClient.createStaff({
          firstName: primeiro ?? prof.nome,
          lastName: resto.join(' ') || primeiro || prof.nome,
          email: prof.email,
          sourceId: prof.codProf,
        }),
      );
      await idMappingRepository.upsert({ entityType: 'STAFF', rmCode: prof.codProf, toddleId: staffId });
      resumo.criados += 1;
      staffPorCodProf.set(prof.codProf, staffId);
      logger.info({ codProf: prof.codProf, staffId, nome: prof.nome }, 'staff criado e mapeado');
    } catch (error) {
      resumo.falhas.push({ o_que: 'criar staff', alvo: `${prof.codProf} ${prof.nome}`, erro: (error as Error).message });
      logger.error({ codProf: prof.codProf, error }, 'falha ao criar staff');
    }
    await dorme(INTERVALO_MS);
  }

  // 3. Vínculos, agrupados por turma: o endpoint aceita array, e 70 das 202
  //    turma-disciplina têm mais de um docente.
  const porTurma = new Map<string, typeof vincular>();
  for (const v of vincular) {
    if (!porTurma.has(v.classId)) porTurma.set(v.classId, []);
    porTurma.get(v.classId)!.push(v);
  }

  for (const [classId, lista] of [...porTurma.entries()].slice(0, limite)) {
    try {
      await comPaciencia(() =>
        toddleClient.addStaffToClass(classId, lista.map((v) => ({ id: v.staffId, roleId: papel.roleId }))),
      );
      resumo.vinculados += lista.length;
      logger.info({ classId, quantos: lista.length, turma: lista[0]?.rotulo }, 'professores vinculados à turma');
    } catch (error) {
      resumo.falhas.push({ o_que: 'vincular', alvo: lista[0]?.rotulo ?? classId, erro: (error as Error).message });
      logger.error({ classId, error }, 'falha ao vincular');
    }
    await dorme(INTERVALO_MS);
  }

  logger.info(resumo, resumo.falhas.length === 0 ? 'Sync de professores concluído' : 'Sync concluído COM FALHAS');
  return resumo;
}
