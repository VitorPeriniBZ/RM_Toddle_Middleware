import { Pool } from 'pg';
import { env } from '@rm-toddle/config';

/** Banco LOCAL do middleware (PostgreSQL): id_mapping + controle de migrations. */
export const pgPool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
});
