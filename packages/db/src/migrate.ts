import fs from 'node:fs';
import path from 'node:path';
import { pgPool } from './pool';
import { logger } from '@rm-toddle/config';

/**
 * Runner de migrations minimalista: aplica os .sql de src/db/migrations em
 * ordem alfabética, uma única vez cada (controle em schema_migrations).
 * Rodar com: npm run db:migrate
 */
/**
 * Espera o Postgres aceitar conexão, com backoff.
 *
 * Existe porque em produção o Postgres é um RECURSO GERENCIADO do Coolify, não
 * um serviço do nosso compose — então `depends_on` com healthcheck não alcança
 * ele: o compose nem sabe que existe. Sem espera, o `init` conecta uma única vez
 * e, se o banco ainda estiver subindo, morre — e como o `worker` depende de
 * `service_completed_successfully`, o DEPLOY INTEIRO falha por uma corrida de
 * alguns segundos, com tudo configurado corretamente.
 *
 * Distingue os dois tipos de falha de propósito: indisponibilidade é transitória
 * e vale retentar; credencial errada e banco inexistente não melhoram com
 * espera, então falham na hora com a mensagem real em vez de esconder o motivo
 * atrás de 30s de tentativas.
 */
async function esperarPostgres(tentativas = 10): Promise<void> {
  // ENOTFOUND entra na lista porque o DNS interno do Docker pode não ter o nome
  // do serviço no primeiro instante do deploy.
  const transitorios = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET']);

  for (let tentativa = 1; ; tentativa += 1) {
    try {
      const client = await pgPool.connect();
      client.release();
      if (tentativa > 1) logger.info({ tentativa }, 'Postgres respondeu');
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (!code || !transitorios.has(code) || tentativa >= tentativas) {
        logger.error(
          { err, code, tentativa, transitorio: code ? transitorios.has(code) : false },
          'Postgres inalcançável — confira a DATABASE_URL (host interno do recurso, usuário, senha e nome do banco)',
        );
        throw err;
      }
      const esperaMs = Math.min(2 ** (tentativa - 1) * 500, 8_000);
      logger.warn({ code, tentativa, tentativas, esperaMs }, 'Postgres ainda não aceita conexão — aguardando');
      await new Promise((r) => setTimeout(r, esperaMs));
    }
  }
}

async function migrate(): Promise<void> {
  await esperarPostgres();

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
