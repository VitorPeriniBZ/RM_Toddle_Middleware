import sql from 'mssql';
import { env, isRmSqlConfigured } from '../config/env';
import { getRmSqlPool } from '../clients/rm-database/rmSqlPool';
import { StudentEnrichment } from '../schemas/jobs.schema';
import { chunk } from '../utils/array';
import { sanitizeEmail } from '../utils/name';
import { logger } from '../utils/logger';

/**
 * A API /StudentContexts não traz e-mail, nascimento nem gênero. Esses dados
 * vivem em PPESSOA, alcançada por SALUNO.CODPESSOA = PPESSOA.CODIGO
 * (relacionamento real do GLINKSREL). Passo OPCIONAL: sem RM_SQL_* no .env,
 * o sync roda só com os dados da API.
 */
export async function enrichStudentsFromRmDatabase(
  studentCodes: string[],
): Promise<Map<string, StudentEnrichment>> {
  const result = new Map<string, StudentEnrichment>();
  if (studentCodes.length === 0) return result;

  if (!isRmSqlConfigured) {
    logger.warn('RM_SQL_* não configurado — enriquecimento (e-mail/dob/gênero) será pulado');
    return result;
  }

  const pool = await getRmSqlPool();

  // IN (...) parametrizado tem limite de parâmetros no SQL Server — chunks de 500.
  for (const group of chunk(studentCodes, 500)) {
    const request = pool.request();
    request.input('codColigada', sql.Int, env.RM_CODCOLIGADA);

    const placeholders = group.map((ra, i) => {
      request.input(`ra${i}`, sql.VarChar, ra);
      return `@ra${i}`;
    });

    const query = `
      SELECT A.RA, P.EMAIL, P.DTNASCIMENTO, P.SEXO
      FROM SALUNO A
      JOIN PPESSOA P ON P.CODIGO = A.CODPESSOA
      WHERE A.CODCOLIGADA = @codColigada
        AND A.RA IN (${placeholders.join(', ')})
    `;

    const { recordset } = await request.query<{
      RA: string;
      EMAIL: string | null;
      DTNASCIMENTO: Date | string | null;
      SEXO: string | null;
    }>(query);

    for (const row of recordset) {
      const gender = row.SEXO?.trim().toUpperCase();
      result.set(String(row.RA).trim(), {
        email: sanitizeEmail(row.EMAIL),
        dob: toIsoDate(row.DTNASCIMENTO),
        // Toddle aceita M/F/X; o RM usa M/F — qualquer outro valor é omitido.
        gender: gender === 'M' || gender === 'F' ? gender : undefined,
      });
    }
  }

  logger.info({ solicitados: studentCodes.length, enriquecidos: result.size }, 'Enriquecimento via banco do RM concluído');
  return result;
}

/** Normaliza Date | string do SQL Server para YYYY-MM-DD (formato do Toddle). */
function toIsoDate(value: Date | string | null): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}
