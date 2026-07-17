import fs from 'node:fs';
import path from 'node:path';
import { pgPool } from './pool';
import { logger } from '../utils/logger';

/**
 * Runner de migrations minimalista: aplica os .sql de src/db/migrations em
 * ordem alfabética, uma única vez cada (controle em schema_migrations).
 * Rodar com: npm run db:migrate
 */
async function migrate(): Promise<void> {
  const client = await pgPool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const dir = path.join(__dirname, 'migrations');
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const { rowCount } = await client.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
      if (rowCount) {
        logger.debug({ file }, 'Migration já aplicada');
        continue;
      }

      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        logger.info({ file }, 'Migration aplicada');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    client.release();
  }
  await pgPool.end();
}

migrate().catch((err) => {
  logger.error({ err }, 'Falha ao aplicar migrations');
  process.exit(1);
});
