import { logger } from '@rm-toddle/config';
import { pgPool } from '@rm-toddle/db';
import {
  executarEscritaFrequencia,
  parseArgs,
} from '../workers/toddle-to-rm/frequenciaWrite';

/**
 * CLI da escrita de frequência Toddle -> RM.
 *
 *   npm run escrever:frequencia -- --de 2026-08-24 --ate 2026-08-24
 *   npm run escrever:frequencia -- --de 2026-08-24 --ate 2026-08-24 --turma 1266
 *   npm run escrever:frequencia -- ... --executar
 *
 * A lógica mora em `workers/toddle-to-rm/frequenciaWrite.ts`, compartilhada com
 * o job agendado. Aqui só ficam o parsing dos argumentos e o encerramento do
 * pool — porque a CLI sai e o worker não.
 */
async function main(): Promise<void> {
  await executarEscritaFrequencia(parseArgs());
  await pgPool.end();
}

main().catch(async (err) => {
  logger.error({ err }, 'Falha na escrita de frequência');
  await pgPool.end().catch(() => undefined);
  process.exit(1);
});
