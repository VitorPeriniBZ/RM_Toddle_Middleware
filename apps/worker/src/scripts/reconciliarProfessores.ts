import { logger } from '@rm-toddle/config';
import { idMappingRepository, pgPool } from '@rm-toddle/db';
import { fetchTeachersFromRm } from '@rm-toddle/domain';
import { toddleClient } from '@rm-toddle/integrations';

/**
 * Compara os PROFESSORES e os vínculos professor↔turma-disciplina do RM com o
 * nosso de-para e com o Toddle, e relata a DERIVA.
 * SOMENTE LEITURA — não cria, não arquiva, não vincula nada.
 *
 *   npm run reconciliar:professores
 *
 * ─── POR QUE ISTO EXISTE ────────────────────────────────────────────────────
 *
 * Os 31 `STAFF` vieram de carga manual e **nada os atualiza** — a mesma deriva
 * que deixou a turma `1714` de fora por dias, com 60 faltas lançadas. Aqui a
 * deriva é DETECTADA em vez de descoberta por acidente.
 *
 * ─── POR QUE RELATÓRIO ANTES DE SYNC ────────────────────────────────────────
 *
 * Uma restrição da API é irreversível, a outra não — e a diferença define o que
 * pode ser automatizado:
 *
 *   1. `POST /staff` EXIGE e-mail e o usa como IDENTIDADE. E-mail errado cria
 *      conta inacessível que só pode ser ARQUIVADA, nunca excluída. Chutar
 *      e-mail é pior que não criar. **Irreversível: exige decisão humana.**
 *   2. O vínculo turma↔professor é REVERSÍVEL: existe
 *      `PUT /courses/:id/staffs/remove` (confirmado na referência da 2.0 em
 *      10/08/2026, depois de eu ter afirmado o contrário). Então vincular errado
 *      se desfaz — o vínculo é candidato legítimo a automação.
 *
 * O `add` exige `{ staffs: [{ id, roleId }] }`, e o `roleId` do nível CLASS varia
 * por organização: resolver por NOME ("Class Teacher") mantém o white label.
 *
 * ─── O QUE ESTE RELATÓRIO VERIFICA DE FATO ──────────────────────────────────
 *
 * A primeira versão marcava `OK` só porque o professor estava mapeado, sem nunca
 * olhar se ele estava NA TURMA. Agora consulta `GET /courses/:id/staffs` por
 * turma — o único caminho, porque o `GET /courses` não devolve staff. Daí as
 * situações VINCULO_AUSENTE_NO_TODDLE e VINCULO_SOBRANDO_NO_TODDLE.
 */

type Situacao =
  | 'OK'
  | 'PROF_NOVO'
  | 'PROF_SEM_EMAIL'
  | 'PROF_SUMIU_DO_RM'
  | 'TURMA_NAO_MAPEADA'
  | 'VINCULO_FALTANDO'
  | 'VINCULO_AUSENTE_NO_TODDLE'
  | 'VINCULO_SOBRANDO_NO_TODDLE';

interface Achado {
  situacao: Situacao;
  codProf?: string;
  nome?: string;
  idTurmaDisc?: string;
  detalhe: string;
}

async function main(): Promise<void> {
  const achados: Achado[] = [];

  // 1. RM: fonte de verdade de quem leciona o quê.
  const { professores, turmaDiscs, foraDoEscopo, semProfessor } = await fetchTeachersFromRm();

  // 2. Nosso de-para.
  const staffMap = await idMappingRepository.listByType('STAFF', 'active');
  const courseMap = await idMappingRepository.listByType('COURSE', 'active');
  const staffPorCodProf = new Map(staffMap.map((m) => [m.rmCode, m.toddleId]));
  const cursoPorId = new Map(courseMap.map((m) => [m.rmCode, m.toddleId]));

  // 3. Toddle: quem já está lá de fato. Confiar só no de-para esconderia staff
  //    criado à mão — e criar duplicata de professor é irreversível.
  const staffToddle: Array<Record<string, unknown>> = [];
  for (let pagina = 1; pagina <= 20; pagina += 1) {
    const lote = await toddleClient.listStaffPage(pagina);
    if (lote.length === 0) break;
    staffToddle.push(...lote);
  }
  const emailsNoToddle = new Set(
    staffToddle
      .map((s) => String((s.email as string) ?? '').trim().toLowerCase())
      .filter(Boolean),
  );

  // --- professores ---
  for (const prof of professores.values()) {
    const mapeado = staffPorCodProf.get(prof.codProf);

    if (!prof.email) {
      achados.push({
        situacao: 'PROF_SEM_EMAIL',
        codProf: prof.codProf,
        nome: prof.nome,
        detalhe: `sem e-mail no RM (nem institucional nem pessoal) — POST /staff impossível; ${prof.turmaDiscIds.length} turma-disc afetadas`,
      });
      continue;
    }

    if (mapeado) {
      achados.push({ situacao: 'OK', codProf: prof.codProf, nome: prof.nome, detalhe: `staff ${mapeado}` });
      continue;
    }

    // Não mapeado. Já existe no Toddle pelo e-mail? Então é só o de-para que
    // está furado — criar de novo geraria duplicata inacessível.
    const jaNoToddle = emailsNoToddle.has(prof.email.toLowerCase());
    achados.push({
      situacao: 'PROF_NOVO',
      codProf: prof.codProf,
      nome: prof.nome,
      detalhe: jaNoToddle
        ? `NÃO mapeado, mas o e-mail ${prof.email} JÁ EXISTE no Toddle — vincular o de-para, NÃO criar`
        : `NÃO mapeado e ausente do Toddle — criar staff (${prof.email})`,
    });
  }

  // Mapeado aqui e ausente do RM: professor que saiu, ou CODPROF que mudou.
  for (const m of staffMap) {
    if (!professores.has(m.rmCode)) {
      achados.push({
        situacao: 'PROF_SUMIU_DO_RM',
        codProf: m.rmCode,
        detalhe: `mapeado para staff ${m.toddleId}, mas não leciona nada no escopo — saiu da escola? mudou de campus?`,
      });
    }
  }

  // 4. Vínculos REAIS no Toddle, em poucas chamadas por cursor.
  //
  //    A primeira versão fazia um `GET /courses/:id/staffs` por turma — 186
  //    chamadas, que estouraram o rate limit e revelaram que a janela dele é de
  //    300 SEGUNDOS. Aqui são ~7 páginas de 400.
  const enrollments = await toddleClient.listEnrollments();
  const staffPorTurma = new Map<string, Set<string>>();
  const dadosDoStaff = new Map<string, Record<string, unknown>>();
  for (const e of enrollments) {
    if (String(e.type ?? '') !== 'staff') continue;
    if (e.isClassArchived === true) continue; // turma arquivada não é deriva
    const courseId = String(e.courseId ?? '');
    const userId = String(e.userId ?? '');
    if (!courseId || !userId) continue;
    if (!staffPorTurma.has(courseId)) staffPorTurma.set(courseId, new Set());
    staffPorTurma.get(courseId)!.add(userId);
    dadosDoStaff.set(userId, e);
  }
  logger.info(
    { enrollmentsTotal: enrollments.length, vinculosDeStaff: [...staffPorTurma.values()].reduce((n, s) => n + s.size, 0) },
    'Vínculos lidos via GET /enrollments (cursor)',
  );

  // --- vínculos professor <-> turma-disciplina ---
  for (const td of turmaDiscs.values()) {
    const classId = cursoPorId.get(td.idTurmaDisc);
    if (!classId) {
      achados.push({
        situacao: 'TURMA_NAO_MAPEADA',
        idTurmaDisc: td.idTurmaDisc,
        detalhe: `${td.codTurma}/${td.nomeDisciplina} não tem COURSE mapeado — sem class no Toddle não há onde vincular professor`,
      });
      continue;
    }
    const esperados = new Map<string, string>(); // staffId -> codProf
    for (const codProf of td.codProfs) {
      const staffId = staffPorCodProf.get(codProf);
      if (!staffId) {
        achados.push({
          situacao: 'VINCULO_FALTANDO',
          codProf,
          idTurmaDisc: td.idTurmaDisc,
          detalhe: `${td.codTurma}/${td.nomeDisciplina}: professor ${codProf} (${professores.get(codProf)?.nome ?? '?'}) sem staff mapeado`,
        });
        continue;
      }
      esperados.set(staffId, codProf);
    }

    // O vínculo REAL no Toddle. Sem isto o relatório diria "OK" só porque o
    // professor está mapeado — sem nunca ter olhado se ele está na turma.
    const idsNaTurma = staffPorTurma.get(classId) ?? new Set<string>();

    for (const [staffId, codProf] of esperados) {
      if (!idsNaTurma.has(staffId)) {
        achados.push({
          situacao: 'VINCULO_AUSENTE_NO_TODDLE',
          codProf,
          idTurmaDisc: td.idTurmaDisc,
          detalhe: `${td.codTurma}/${td.nomeDisciplina}: ${professores.get(codProf)?.nome ?? codProf} deveria estar na turma e NÃO está (staff ${staffId})`,
        });
      }
    }

    // Sobrando: está no Toddle e não no RM. Pode ser alocação feita à mão pela
    // coordenação — por isso é relato, não candidato automático a remoção.
    for (const id of idsNaTurma) {
      if (!esperados.has(id)) {
        const d = dadosDoStaff.get(id) ?? {};
        const quem = [d.firstName, d.lastName].filter(Boolean).join(' ') || id;
        achados.push({
          situacao: 'VINCULO_SOBRANDO_NO_TODDLE',
          idTurmaDisc: td.idTurmaDisc,
          detalhe: `${td.codTurma}/${td.nomeDisciplina}: ${quem} (staff ${id}, papel "${d.roleName ?? '?'}") está na turma mas NÃO no RM`,
        });
      }
    }
  }

  // --- relatório ---
  const porSituacao = new Map<Situacao, Achado[]>();
  for (const a of achados) {
    if (!porSituacao.has(a.situacao)) porSituacao.set(a.situacao, []);
    porSituacao.get(a.situacao)!.push(a);
  }

  const multiprof = [...turmaDiscs.values()].filter((t) => t.codProfs.length > 1).length;

  logger.info(
    {
      rm: { professores: professores.size, turmaDiscs: turmaDiscs.size, multiprofessor: multiprof, foraDoEscopo, semProfessor },
      dePara: { staff: staffMap.length, course: courseMap.length },
      toddle: { staffTotal: staffToddle.length },
    },
    'Reconciliação de professores — panorama',
  );

  const ordem: Situacao[] = ['PROF_SEM_EMAIL', 'PROF_NOVO', 'PROF_SUMIU_DO_RM', 'TURMA_NAO_MAPEADA', 'VINCULO_FALTANDO', 'VINCULO_AUSENTE_NO_TODDLE', 'VINCULO_SOBRANDO_NO_TODDLE', 'OK'];
  for (const s of ordem) {
    const lista = porSituacao.get(s) ?? [];
    if (lista.length === 0) continue;
    logger.info({ situacao: s, total: lista.length }, `--- ${s} ---`);
    // OK é ruído: só a contagem interessa.
    if (s === 'OK') continue;
    for (const a of lista.slice(0, 40)) {
      logger.info({ codProf: a.codProf, idTurmaDisc: a.idTurmaDisc, nome: a.nome }, `  ${a.detalhe}`);
    }
    if (lista.length > 40) logger.info(`  ... e mais ${lista.length - 40}`);
  }

  const acionaveis = achados.filter((a) => a.situacao !== 'OK').length;
  logger.info({ acionaveis, total: achados.length }, acionaveis === 0 ? 'Sem deriva 🎉' : 'Deriva encontrada');

  await pgPool.end();
}

main().catch((error) => {
  logger.error({ error }, 'Falha na reconciliação de professores');
  process.exit(1);
});
