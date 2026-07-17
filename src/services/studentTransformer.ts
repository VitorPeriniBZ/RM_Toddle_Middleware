import { RmStudentContext } from '../clients/totvs/types';
import {
  StudentEnrichment,
  StudentSyncItem,
} from '../schemas/jobs.schema';
import {
  CreateToddleStudentPayload,
  UpdateToddleStudentPayload,
  createToddleStudentSchema,
  updateToddleStudentSchema,
} from '../schemas/toddleStudent.schema';
import { buildSourceId } from './sourceId';
import { splitFullName } from '../utils/name';
import { yearGroupKeyFromContext } from './yearGroupResolver';

/**
 * Camada de transformação: isola o "dialeto" de cada sistema.
 * RmStudentContext -> StudentSyncItem (neutro, vai na fila) -> payload Toddle
 * (validado com Zod na saída).
 */

/** Normaliza um contexto do RM em item neutro de sincronização. */
export function toSyncItem(
  ctx: RmStudentContext,
  enrichment?: StudentEnrichment,
): StudentSyncItem | null {
  const studentCode = ctx.StudentCode !== undefined && ctx.StudentCode !== null
    ? String(ctx.StudentCode).trim()
    : '';
  const studentName = ctx.StudentName?.trim() ?? '';

  // Sem RA ou sem nome não há o que sincronizar — descarta com log no chamador.
  if (!studentCode || !studentName) return null;

  return {
    studentCode,
    studentInternalId: ctx.StudentInternalId ? String(ctx.StudentInternalId) : undefined,
    studentName,
    yearGroupKey: yearGroupKeyFromContext(ctx),
    classCode: ctx.ClassCode !== undefined && ctx.ClassCode !== null ? String(ctx.ClassCode) : undefined,
    termStatus: ctx.TermStatus !== undefined && ctx.TermStatus !== null ? String(ctx.TermStatus) : undefined,
    majorStatus: ctx.MajorStatus !== undefined && ctx.MajorStatus !== null ? String(ctx.MajorStatus) : undefined,
    enrichment,
  };
}

/** Payload de CRIAÇÃO no Toddle — yearGroupId é obrigatório aqui. */
export function toCreatePayload(
  item: StudentSyncItem,
  yearGroupId: string,
): CreateToddleStudentPayload {
  const { firstName, lastName } = splitFullName(item.studentName);

  return createToddleStudentSchema.parse({
    firstName,
    lastName,
    yearGroupId,
    sourceId: buildSourceId(item.studentCode),
    email: item.enrichment?.email,
    gender: item.enrichment?.gender,
    dob: item.enrichment?.dob,
  });
}

/**
 * Payload de ATUALIZAÇÃO — NÃO reenvia yearGroupId: mudança de série é
 * decisão pedagógica feita no Toddle, não cabe ao sync sobrescrever.
 */
export function toUpdatePayload(item: StudentSyncItem): UpdateToddleStudentPayload {
  const { firstName, lastName } = splitFullName(item.studentName);

  return updateToddleStudentSchema.parse({
    firstName,
    lastName,
    email: item.enrichment?.email,
    gender: item.enrichment?.gender,
    dob: item.enrichment?.dob,
  });
}
