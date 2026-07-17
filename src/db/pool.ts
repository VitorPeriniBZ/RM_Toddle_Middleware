import { Pool } from 'pg';
import { env } from '../config/env';

/** Banco LOCAL do middleware (PostgreSQL): id_mapping + controle de migrations. */
export const pgPool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
});
