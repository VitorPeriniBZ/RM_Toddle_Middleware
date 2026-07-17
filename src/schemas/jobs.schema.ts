import { z } from 'zod';

/**
 * Schemas dos payloads que trafegam nas filas. Todo job é validado na
 * ENTRADA do processor (payload corrompido/antigo falha rápido e cai na DLQ
 * com erro claro, em vez de gravar lixo no Toddle).
 */

/** Job "students.extract" — dispara a varredura completa do RM. */
export const studentExtractJobSchema = z.object({
  trigger: z.enum(['manual', 'cron']).default('manual'),
});
export type StudentExtractJob = z.infer<typeof studentExtractJobSchema>;

/** Dados complementares vindos do banco do RM (PPESSOA). */
export const enrichmentSchema = z.object({
  email: z.string().optional(),
  /** YYYY-MM-DD */
  dob: z.string().optional(),
  gender: z.enum(['M', 'F']).optional(),
});
export type StudentEnrichment = z.infer<typeof enrichmentSchema>;

/** Um aluno já deduplicado/normalizado, pronto para o upsert. */
export const studentSyncItemSchema = z.object({
  studentCode: z.string().min(1),
  studentInternalId: z.string().optional(),
  studentName: z.string().min(1),
  /** Chave usada para resolver o yearGroupId no Toddle (padrão: CourseCode). */
  yearGroupKey: z.string().optional(),
  classCode: z.string().optional(),
  termStatus: z.string().optional(),
  majorStatus: z.string().optional(),
  enrichment: enrichmentSchema.optional(),
});
export type StudentSyncItem = z.infer<typeof studentSyncItemSchema>;

/** Job "students.upsert-batch" — um lote de alunos para upsert no Toddle. */
export const studentUpsertBatchJobSchema = z.object({
  runId: z.string().min(1),
  batchIndex: z.number().int().nonnegative(),
  students: z.array(studentSyncItemSchema).min(1),
});
export type StudentUpsertBatchJob = z.infer<typeof studentUpsertBatchJobSchema>;
