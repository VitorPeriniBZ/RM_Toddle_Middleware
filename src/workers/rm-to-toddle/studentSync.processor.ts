import { Job } from 'bullmq';
import { env } from '../../config/env';
import { totvsClient } from '../../clients/totvs/totvsEducationalClient';
import { toddleClient } from '../../clients/toddle/toddleClient';
import { idMappingRepository } from '../../repositories/idMappingRepository';
import {
  StudentSyncItem,
  StudentUpsertBatchJob,
  studentExtractJobSchema,
  studentUpsertBatchJobSchema,
} from '../../schemas/jobs.schema';
import { enrichStudentsFromRmDatabase } from '../../services/studentEnrichment';
import { toCreatePayload, toSyncItem, toUpdatePayload } from '../../services/studentTransformer';
import { buildSourceId, rmCodeFromSourceId } from '../../services/sourceId';
import { resolveYearGroupId } from '../../services/yearGroupResolver';
import { getQueue } from '../../queues/queues';
import { QUEUE, STUDENT_JOB } from '../../queues/names';
import { RmStudentContext } from '../../clients/totvs/types';
import { chunk } from '../../utils/array';
import { logger } from '../../utils/logger';

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
  log.info('Extract de alunos iniciado (RM /StudentContexts)');

  // 1. Varre todas as páginas do RM, deduplicando por RA.
  //    Um aluno aparece em VÁRIOS contextos (curso/turma/período) — mantemos
  //    o primeiro contexto ATIVO encontrado (ou o primeiro geral, na ausência).
  const byStudentCode = new Map<string, RmStudentContext>();
  let totalContexts = 0;

  for await (const page of totvsClient.iterateStudentContexts()) {
    totalContexts += page.length;
    for (const ctx of page) {
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
    await job.updateProgress({ phase: 'reading-rm', totalContexts });
  }

  // 2. Filtra por status ativo (RM_ACTIVE_TERM_STATUSES; vazio = aceita todos).
  const activeContexts = [...byStudentCode.values()].filter(isActiveContext);
  log.info(
    { totalContexts, uniqueStudents: byStudentCode.size, active: activeContexts.length },
    'Leitura do RM concluída',
  );

  // 3. Enriquecimento opcional via banco do RM (e-mail, nascimento, gênero).
  const codes = activeContexts.map((ctx) => String(ctx.StudentCode).trim());
  const enrichmentByCode = await enrichStudentsFromRmDatabase(codes);

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

  for (const [batchIndex, students] of batches.entries()) {
    const payload: StudentUpsertBatchJob = { runId, batchIndex, students };
    await queue.add(STUDENT_JOB.UPSERT_BATCH, payload, {
      jobId: `${runId}:students:${batchIndex}`,
    });
  }

  log.info({ runId, batches: batches.length, students: items.length }, 'Fan-out de lotes enfileirado');
  return { totalContexts, uniqueStudents: items.length, batches: batches.length };
}

/** Status "ativo" configurável — os domínios de MajorStatus/TermStatus não são documentados. */
function isActiveContext(ctx: RmStudentContext): boolean {
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
  failed: number;
}> {
  const batch = studentUpsertBatchJobSchema.parse(job.data);
  const log = logger.child({ jobId: job.id, runId: batch.runId, batchIndex: batch.batchIndex });
  log.info({ students: batch.students.length }, 'Upsert de lote iniciado');

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
      if (student.archived) {
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
  const failures: Array<{ studentCode: string; error: string }> = [];

  for (const item of batch.students) {
    try {
      const mapping = mappings.get(item.studentCode);

      if (mapping) {
        await toddleClient.updateStudent(mapping.toddleId, toUpdatePayload(item));
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

  log.info({ created, updated, failed: failures.length }, 'Upsert de lote concluído');

  if (failures.length > 0) {
    // Dispara a retentativa exponencial do BullMQ (3x) e, esgotada, a DLQ.
    throw new Error(
      `${failures.length}/${batch.students.length} alunos falharam no lote ${batch.batchIndex}: ` +
        failures.map((f) => `${f.studentCode} (${f.error})`).join('; '),
    );
  }

  return { created, updated, failed: 0 };
}
