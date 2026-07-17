import { env } from '../config/env';
import { idMappingRepository } from '../repositories/idMappingRepository';
import { RmStudentContext } from '../clients/totvs/types';

/**
 * O POST /students do Toddle EXIGE yearGroupId — conceito que o RM não tem.
 * Estratégia:
 *   1. Procurar na id_mapping um registro YEAR_GROUP cujo rm_code seja a
 *      "chave de série" do aluno no RM (padrão: CourseCode).
 *   2. Fallback: TODDLE_DEFAULT_YEAR_GROUP_ID do .env.
 *   3. Sem os dois -> erro instrutivo (o job cai na DLQ com a causa clara).
 *
 * O script `npm run seed:yeargroups` lista os year groups do Toddle e grava
 * os mapeamentos.
 */
export async function resolveYearGroupId(yearGroupKey?: string): Promise<string> {
  if (yearGroupKey) {
    const mapping = await idMappingRepository.findByRmCode('YEAR_GROUP', yearGroupKey);
    if (mapping) return mapping.toddleId;
  }

  if (env.TODDLE_DEFAULT_YEAR_GROUP_ID) return env.TODDLE_DEFAULT_YEAR_GROUP_ID;

  throw new Error(
    `yearGroupId não resolvido (chave RM: ${yearGroupKey ?? 'ausente'}). ` +
      'Rode "npm run seed:yeargroups -- list" e mapeie com ' +
      '"npm run seed:yeargroups -- map <chaveRM> <yearGroupId>", ' +
      'ou defina TODDLE_DEFAULT_YEAR_GROUP_ID no .env.',
  );
}

/**
 * Qual campo do contexto do RM representa a "série/ano" do aluno.
 * Ajuste aqui se na sua escola a série estiver em outro campo
 * (ex.: MajorCode ou parte do ClassCode).
 */
export function yearGroupKeyFromContext(ctx: RmStudentContext): string | undefined {
  const key = ctx.CourseCode ?? ctx.MajorCode;
  return key !== undefined && key !== null ? String(key) : undefined;
}
