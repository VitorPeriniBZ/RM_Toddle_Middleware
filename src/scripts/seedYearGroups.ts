import { toddleClient } from '../clients/toddle/toddleClient';
import { idMappingRepository } from '../repositories/idMappingRepository';
import { pgPool } from '../db/pool';
import { logger } from '../utils/logger';

/**
 * O create de aluno no Toddle exige yearGroupId — conceito que o RM não tem.
 * Este script cria o "de-para" série RM <-> year group Toddle na id_mapping.
 *
 * Uso:
 *   npm run seed:yeargroups -- list                        # lista os year groups do Toddle
 *   npm run seed:yeargroups -- map <chaveRM> <yearGroupId> # grava um mapeamento
 *
 * <chaveRM> = valor devolvido por yearGroupKeyFromContext (padrão: CourseCode).
 */
async function main(): Promise<void> {
  const [command, rmKey, yearGroupId] = process.argv.slice(2);

  if (command === 'list') {
    const yearGroups = await toddleClient.getYearGroups();
    if (yearGroups.length === 0) logger.warn('Nenhum year group retornado pelo Toddle');
    for (const yg of yearGroups) {
      logger.info({ id: yg.id, name: yg.name }, 'Year group');
    }
  } else if (command === 'map' && rmKey && yearGroupId) {
    const mapping = await idMappingRepository.upsert({
      entityType: 'YEAR_GROUP',
      rmCode: rmKey,
      toddleId: yearGroupId,
    });
    logger.info({ rmCode: mapping.rmCode, toddleId: mapping.toddleId }, 'Mapeamento de year group gravado');
  } else {
    logger.info('Uso: npm run seed:yeargroups -- list | map <chaveRM> <yearGroupId>');
  }

  await pgPool.end();
}

main().catch((error) => {
  logger.error({ error }, 'Falha no seed de year groups');
  process.exit(1);
});
