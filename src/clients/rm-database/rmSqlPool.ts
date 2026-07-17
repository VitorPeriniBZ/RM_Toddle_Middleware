import sql from 'mssql';
import { env, isRmSqlConfigured } from '../../config/env';
import { logger } from '../../utils/logger';

/**
 * Pool de conexão com o BANCO do TOTVS RM (SQL Server).
 * Usos: (a) enriquecimento do Fluxo 1 (e-mail/nascimento/gênero via PPESSOA);
 * (b) Fluxo 2 — escrita acadêmica (SFREQUENCIA, SNOTAS...).
 *
 * ATENÇÃO: escrever direto no banco do RM pula as regras de negócio da
 * aplicação. Restrinja o usuário SQL ao mínimo necessário e valide as
 * colunas/constraints com o dicionário de dados antes de ativar o Fluxo 2.
 */
let pool: sql.ConnectionPool | null = null;

export async function getRmSqlPool(): Promise<sql.ConnectionPool> {
  if (!isRmSqlConfigured) {
    throw new Error(
      'Conexão SQL do RM não configurada (RM_SQL_SERVER/DATABASE/USER/PASSWORD).',
    );
  }

  if (pool?.connected) return pool;

  pool = new sql.ConnectionPool({
    server: env.RM_SQL_SERVER as string,
    port: env.RM_SQL_PORT,
    database: env.RM_SQL_DATABASE as string,
    user: env.RM_SQL_USER as string,
    password: env.RM_SQL_PASSWORD as string,
    pool: { max: 5, min: 0 },
    options: {
      encrypt: env.RM_SQL_ENCRYPT,
      trustServerCertificate: env.RM_SQL_TRUST_CERT,
    },
  });

  await pool.connect();
  logger.info({ server: env.RM_SQL_SERVER, database: env.RM_SQL_DATABASE }, 'Pool SQL do RM conectado');
  return pool;
}

export async function closeRmSqlPool(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = null;
  }
}
