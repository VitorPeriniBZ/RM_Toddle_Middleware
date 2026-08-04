import { Job } from 'bullmq';
import { env } from '@rm-toddle/config';
import { configVersion, configVersionDetalhe } from '@rm-toddle/config';
import { toddleClient } from '@rm-toddle/integrations';
import { isToddleStudentArchived } from '@rm-toddle/integrations';
import { idMappingRepository } from '@rm-toddle/db';
import {
  StudentSyncItem,
  StudentUpsertBatchJob,
  studentExtractJobSchema,
  studentUpsertBatchJobSchema,
} from '@rm-toddle/contracts';
import { fetchStudentsFromRm } from '@rm-toddle/domain';
import { toCreatePayload, toSyncItem, toUpdatePayload } from '@rm-toddle/domain';
import { buildSourceId, rmCodeFromSourceId } from '@rm-toddle/domain';
import { resolveYearGroupId } from '@rm-toddle/domain';
import { getQueue } from '@rm-toddle/queues';
import { QUEUE, STUDENT_JOB } from '@rm-toddle/queues';
import { RmStudentContext } from '@rm-toddle/integrations';
import { chunk } from '@rm-toddle/config';
import { logger } from '@rm-toddle/config';

/**
 * FLUXO 1 — Sincronização de Alunos (TOTVS RM -> Toddle), em duas fases:
 *
 *  students.extract       Varre /StudentContexts paginado (page/pageSize até
 *                         hasNext=false), deduplica por RA, filtra status
 *                         ativos, enriquece via SQL e faz FAN-OUT em lotes.
 *
 *  students.upsert-batch  Para cada lote: resolve o toddle_id na tabela de
 *                         mapeamento local; se não achar, procura no Toddle
 *                         por sourceId; então PUT (update) ou POST (create)
 *                         e grava/atualiza o mapeamento.
 *
 * Idempotência em 3 camadas: id_mapping local -> GET por sourceId no Toddle
 * -> upsert do mapeamento após cada operação. Reprocessar o mesmo job nunca
 * duplica aluno.
 */

// ---------------------------------------------------------------------------
// Fase 1: EXTRACT
// ---------------------------------------------------------------------------

export async function processStudentExtract(job: Job): Promise<{
  totalContexts: number;
  uniqueStudents: number;
  batches: number;
}> {
  const { trigger } = studentExtractJobSchema.parse(job.data ?? {});
  const log = logger.child({ jobId: job.id, jobName: job.name, trigger });
  log.info('Extract de alunos iniciado (RM wsConsultaSQL)');

  // 1. Lê o roster completo via Sentença SQL (SOAP) — email/dob/gênero já vêm
  //    no mesmo rowset (enrichmentByCode), sem segundo round-trip.
  const { contexts, enrichmentByCode } = await fetchStudentsFromRm();
  await job.updateProgress({ phase: 'reading-rm', totalContexts: contexts.length });

  // Deduplica por RA: um aluno pode vir em várias linhas (curso/turma/período);
  // um contexto ATIVO tem prioridade sobre um inativo.
  const byStudentCode = new Map<string, RmStudentContext>();
  const totalContexts = contexts.length;
  for (const ctx of contexts) {
    const code = ctx.StudentCode !== undefined && ctx.StudentCode !== null
      ? String(ctx.StudentCode).trim()
      : '';
    if (!code) continue;

    const existing = byStudentCode.get(code);
    if (!existing) {
      byStudentCode.set(code, ctx);
    } else if (!isActiveContext(existing) && isActiveContext(ctx)) {
      byStudentCode.set(code, ctx); // contexto ativo tem prioridade
    }
  }

  // 2. Filtra por status ativo (RM_ACTIVE_TERM_STATUSES; vazio = aceita todos).
  const activeContexts = [...byStudentCode.values()].filter(isActiveContext);
  log.info(
    { totalContexts, uniqueStudents: byStudentCode.size, active: activeContexts.length },
    'Leitura do RM concluída',
  );

  // 4. Normaliza para itens neutros de sincronização.
  const items: StudentSyncItem[] = [];
  for (const ctx of activeContexts) {
    const item = toSyncItem(ctx, enrichmentByCode.get(String(ctx.StudentCode).trim()));
    if (item) items.push(item);
    else log.warn({ ctx: { StudentCode: ctx.StudentCode, StudentName: ctx.StudentName } }, 'Contexto sem RA/nome descartado');
  }

  // 5. FAN-OUT: lotes pequenos processados em paralelo, com jobId
  //    determinístico — repetir o extract no MESMO run não duplica lotes.
  const runId = `run-${job.id ?? Date.now()}`;
  const batches = chunk(items, env.SYNC_BATCH_SIZE);
  const queue = getQueue(QUEUE.RM_TO_TODDLE_STUDENTS);

  // Cada lote carrega a impressão digital da configuração vigente AGORA. O
  // upsert recusa o lote se ela divergir na hora de processar.
  const versao = configVersion();
  log.info(configVersionDetalhe(), 'Configuração de escopo/destino deste run');

  for (const [batchIndex, students] of batches.entries()) {
    const payload: StudentUpsertBatchJob = { runId, batchIndex, configVersion: versao, students };
    await queue.add(STUDENT_JOB.UPSERT_BATCH, payload, {
      jobId: `${runId}:students:${batchIndex}`,
    });
  }

  log.info({ runId, batches: batches.length, students: items.length }, 'Fan-out de lotes enfileirado');
  return { totalContexts, uniqueStudents: items.length, batches: batches.length };
}

/**
 * Um aluno está "ativo"? Em ordem de preferência:
 *
 *  1. O flag do PRÓPRIO RM (SSTATUS.PLATIVO -> 'S'/'N'), quando a Sentença o
 *     devolve. É a definição que a escola já mantém no RM e sobrevive à criação
 *     de novos códigos de status — não precisa manter lista no .env.
 *  2. RM_ACTIVE_TERM_STATUSES: lista explícita de códigos, para Sentenças que
 *     não expõem o flag.
 *  3. Sem nenhum dos dois, aceita todos (comportamento histórico).
 *
 * Verificado nesta base em 2026-07-31: PLATIVO='S' cobre Matriculado (484),
 * Matrícula em andamento (24), Matrícula não enturmado (1) e Aluno Visitante
 * (1); 'N' cobre Transferido, Cancelado-Matrícula/Rematrícula e Reopção de
 * Turma — esta última é a linha da turma ANTIGA de quem trocou de turma, e é
 * exatamente o que não pode vencer a desduplicação por RA.
 */
function isActiveContext(ctx: RmStudentContext): boolean {
  const flag = ctx.IsActiveTerm?.trim().toUpperCase();
  if (flag === 'S' || flag === 'T' || flag === '1') return true;
  if (flag === 'N' || flag === 'F' || flag === '0') return false;

  const allowed = env.RM_ACTIVE_TERM_STATUSES
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0) return true; // sem filtro configurado, aceita todos

  const status = ctx.TermStatus ?? ctx.MajorStatus;
  return status !== undefined && status !== null && allowed.includes(String(status).trim());
}

// ---------------------------------------------------------------------------
// Fase 2: UPSERT BATCH
// ---------------------------------------------------------------------------

export async function processStudentUpsertBatch(job: Job): Promise<{
  created: number;
  updated: number;
  unarchived: number;
  failed: number;
}> {
  const batch = studentUpsertBatchJobSchema.parse(job.data);
  const log = logger.child({ jobId: job.id, runId: batch.runId, batchIndex: batch.batchIndex });

  // Recusa ANTES de qualquer escrita: um lote montado sob outra configuração de
  // escopo/destino aplica uma decisão que ninguém mais tomaria. Em 04/08/2026
  // jobs de 31/07 — montados quando RM_CODFILIAL estava vazio — executaram dias
  // depois e tentaram criar alunos de um campus que já havia saído de escopo.
  const atual = configVersion();
  if (batch.configVersion && batch.configVersion !== atual) {
    throw new Error(
      `Lote recusado: foi montado com configuração "${batch.configVersion}" e a atual é ` +
        `"${atual}". Escopo ou destino mudou desde o extract — reenfileire o run em vez ` +
        'de aplicar um lote velho. ' +
        JSON.stringify(configVersionDetalhe()),
    );
  }
  if (!batch.configVersion) {
    log.warn({ configVersionAtual: atual }, 'Lote sem configVersion (enfileirado por versão anterior do código) — processando sem a verificação');
  }

  log.info({ students: batch.students.length, configVersion: atual }, 'Upsert de lote iniciado');

  const rmCodes = batch.students.map((s) => s.studentCode);

  // Camada 1 de idempotência: tabela de mapeamento local.
  const mappings = await idMappingRepository.findManyByRmCodes('STUDENT', rmCodes);

  // Camada 2: para os desconhecidos, procurar no Toddle por sourceId
  // (cobre 1ª execução, restore do banco local ou cargas manuais no Toddle).
  const unknown = batch.students.filter((s) => !mappings.has(s.studentCode));
  if (unknown.length > 0) {
    const sourceIds = unknown.map((s) => buildSourceId(s.studentCode));
    const remote = await toddleClient.getStudentsBySourceIds(sourceIds);

    for (const student of remote) {
      if (!student.sourceId) continue;
      const rmCode = rmCodeFromSourceId(student.sourceId);

      // Aluno existe no Toddle mas está arquivado: reativar antes do update.
      if (isToddleStudentArchived(student)) {
        await toddleClient.unarchiveStudent(student.id);
        log.info({ rmCode, toddleId: student.id }, 'Aluno desarquivado no Toddle');
      }

      const mapping = await idMappingRepository.upsert({
        entityType: 'STUDENT',
        rmCode,
        toddleId: student.id,
      });
      mappings.set(rmCode, mapping);
    }
  }

  // Camada 3: upsert + gravação do mapeamento a cada sucesso individual.
  // Falhas não interrompem o lote; ao final, se houver falhas, o job lança
  // erro para o BullMQ retentar — e os sucessos já persistidos tornam a
  // retentativa idempotente (viram "update").
  let created = 0;
  let updated = 0;
  let unarchived = 0;
  const failures: Array<{ studentCode: string; error: string }> = [];

  for (const item of batch.students) {
    try {
      const mapping = mappings.get(item.studentCode);

      if (mapping) {
        // Mapeamento 'archived' = aluno que saiu do escopo e voltou. Desarquivar
        // ANTES do update: o registro está arquivado no Toddle e atualizá-lo
        // nesse estado não o traz de volta às listagens ativas.
        //
        // Este caminho só existe porque a linha é PRESERVADA no arquivamento —
        // o GET /students não devolve arquivado nem por sourceId, então a
        // camada 2 (busca remota) jamais o encontraria. É a id_mapping que
        // segura o toddle_id.
        if (mapping.state === 'archived') {
          await toddleClient.unarchiveStudent(mapping.toddleId);
          unarchived += 1;
          log.info(
            { studentCode: item.studentCode, toddleId: mapping.toddleId, motivoAnterior: mapping.archiveReason },
            'Aluno voltou ao escopo — desarquivado no Toddle',
          );
        }

        await toddleClient.updateStudent(mapping.toddleId, toUpdatePayload(item));
        // O upsert devolve o estado para 'active' e limpa archived_at/reason.
        await idMappingRepository.upsert({
          entityType: 'STUDENT',
          rmCode: item.studentCode,
          toddleId: mapping.toddleId,
          rmInternalId: item.studentInternalId,
        });
        updated += 1;
      } else {
        const yearGroupId = await resolveYearGroupId(item.yearGroupKey);
        const createdStudent = await toddleClient.createStudent(
          toCreatePayload(item, yearGroupId),
        );
        await idMappingRepository.upsert({
          entityType: 'STUDENT',
          rmCode: item.studentCode,
          toddleId: createdStudent.id,
          rmInternalId: item.studentInternalId,
        });
        created += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ studentCode: item.studentCode, error: message });
      log.error({ studentCode: item.studentCode, error: message }, 'Falha no upsert do aluno');
    }
  }

  log.info({ created, updated, unarchived, failed: failures.length }, 'Upsert de lote concluído');

  if (failures.length > 0) {
    // Dispara a retentativa exponencial do BullMQ (3x) e, esgotada, a DLQ.
    throw new Error(
      `${failures.length}/${batch.students.length} alunos falharam no lote ${batch.batchIndex}: ` +
        failures.map((f) => `${f.studentCode} (${f.error})`).join('; '),
    );
  }

  return { created, updated, unarchived, failed: 0 };
}
