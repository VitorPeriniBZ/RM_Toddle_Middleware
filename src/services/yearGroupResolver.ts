import { env } from '../config/env';
import { idMappingRepository } from '../repositories/idMappingRepository';
import { RmStudentContext } from '../clients/totvs/types';

/**
 * O POST /students do Toddle EXIGE yearGroupId — conceito que o RM não tem.
 * Estratégia:
 *   1. Procurar na id_mapping um registro YEAR_GROUP cujo rm_code seja a
 *      "chave de série" do aluno no RM (padrão: ClassCode / COD_TURMA —
 *      ver yearGroupKeyFromContext). O mapeamento é N:1: várias turmas
 *      apontam para o mesmo year group (EAVHS10IA e EAVHS10IB -> Grade 10).
 *   2. Fallback: TODDLE_DEFAULT_YEAR_GROUP_ID do .env.
 *   3. Sem os dois -> erro instrutivo (o job cai na DLQ com a causa clara).
 *
 * CUIDADO com o passo 2. O year group NÃO é reenviado no update
 * (toUpdatePayload omite yearGroupId de propósito — série é decisão
 * pedagógica do Toddle), então um aluno que cair no default fica naquela
 * coorte PARA SEMPRE: nenhuma execução futura corrige. Em carga inicial,
 * deixe TODDLE_DEFAULT_YEAR_GROUP_ID VAZIO — assim turma não mapeada falha
 * alto na DLQ em vez de aterrissar calada na coorte errada.
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
 * Nesta escola o de-para é por TURMA (COD_TURMA -> ClassCode); CourseCode/
 * MajorCode ficam como fallback caso a turma não venha.
 */
export function yearGroupKeyFromContext(ctx: RmStudentContext): string | undefined {
  const key = ctx.ClassCode ?? ctx.CourseCode ?? ctx.MajorCode;
  return key !== undefined && key !== null ? String(key) : undefined;
}
