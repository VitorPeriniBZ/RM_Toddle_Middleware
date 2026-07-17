import { z } from 'zod';

/**
 * Validação (Zod) do payload ANTES de sair para o Toddle — requisito de
 * segurança do projeto. Campos e formatos conforme POST /public/v2/students:
 * obrigatórios firstName, lastName e yearGroupId; gender em M/F/X;
 * dob em YYYY-MM-DD.
 */
export const createToddleStudentSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  yearGroupId: z.string().min(1),
  /** Nosso elo de idempotência: prefixo + RA do RM. */
  sourceId: z.string().min(1),
  email: z.string().email().optional(),
  preferredName: z.string().min(1).optional(),
  gender: z.enum(['M', 'F', 'X']).optional(),
  dob: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'dob deve estar em YYYY-MM-DD')
    .optional(),
});

export type CreateToddleStudentPayload = z.infer<typeof createToddleStudentSchema>;

/** No PUT todos os campos são opcionais (update parcial). */
export const updateToddleStudentSchema = createToddleStudentSchema.partial();

export type UpdateToddleStudentPayload = z.infer<typeof updateToddleStudentSchema>;
