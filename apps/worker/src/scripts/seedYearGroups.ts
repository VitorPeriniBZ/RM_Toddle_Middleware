import { toddleClient } from '@rm-toddle/integrations';
import { idMappingRepository } from '@rm-toddle/db';
import { pgPool } from '@rm-toddle/db';
import { logger } from '@rm-toddle/config';

/**
 * O create de aluno no Toddle exige yearGroupId — conceito que o RM não tem.
 * Este script cria o "de-para" turma RM <-> year group Toddle na id_mapping.
 *
 * Uso:
 *   npm run seed:yeargroups -- list [curriculumId]         # lista os year groups
 *   npm run seed:yeargroups -- map <chaveRM> <yearGroupId> # grava um mapeamento
 *
 * <chaveRM> = valor devolvido por yearGroupKeyFromContext — nesta escola o
 * COD_TURMA (ex.: EAVHS10IA). O de-para é N:1: EAVHS10IA e EAVHS10IB apontam
 * para o mesmo year group.
 *
 * SEMPRE passe o curriculumId no `list`. Sem ele a API devolve a org inteira
 * com os dois currículos achatados, e os nomes colidem ("Year 1" existe nos
 * dois, com ids diferentes) sem nenhum campo para desempatar. O `name` do year
 * group é a COORTE ("Batch of 2032"), não a série — a série vem em grades[].
 */
async function main(): Promise<void> {
  const [command, rmKey, yearGroupId] = process.argv.slice(2);

  if (command === 'list') {
    const curriculumId = rmKey; // no `list`, o 2º argumento é o curriculumId
    if (!curriculumId) {
      logger.warn(
        'Sem curriculumId: a lista vem da org inteira, com os currículos ' +
          'achatados e nomes repetidos. Use "list <curriculumId>" para o de-para.',
      );
    }
    const yearGroups = await toddleClient.getYearGroups(curriculumId);
    if (yearGroups.length === 0) logger.warn('Nenhum year group retornado pelo Toddle');
    for (const yg of yearGroups) {
      logger.info(
        {
          id: yg.id,
          coorte: yg.name,
          series: yg.grades?.map((g) => `${g.name ?? '?'} (${g.id})`).join(', '),
          org: yg.organizationName,
        },
        'Year group',
      );
    }
  } else if (command === 'map' && rmKey && yearGroupId) {
    const mapping = await idMappingRepository.upsert({
      entityType: 'YEAR_GROUP',
      rmCode: rmKey,
      toddleId: yearGroupId,
    });
    logger.info({ rmCode: mapping.rmCode, toddleId: mapping.toddleId }, 'Mapeamento de year group gravado');
  } else {
    logger.info(
      'Uso: npm run seed:yeargroups -- list [curriculumId] | map <codTurmaRM> <yearGroupId>',
    );
  }

  await pgPool.end();
}

main().catch((error) => {
  logger.error({ error }, 'Falha no seed de year groups');
  process.exit(1);
});
