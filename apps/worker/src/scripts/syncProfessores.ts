import { logger } from '@rm-toddle/config';
import { pgPool } from '@rm-toddle/db';
import { sincronizarProfessores } from '../sync/professores';

/**
 * CLI do sync de professores. A lógica vive em `../sync/professores.ts`, porque
 * o job noturno do BullMQ (`staff.sync`) usa a mesma — duplicar faria os dois
 * divergirem.
 *
 *   npm run sync:professores                          # plano, não escreve nada
 *   npm run sync:professores -- --executar --limite 2 # canário
 *   npm run sync:professores -- --executar            # o resto
 *
 * Diagnóstico completo (inclusive vínculo sobrando no Toddle) em
 * `npm run reconciliar:professores`.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const executar = argv.includes('--executar');
  const iLimite = argv.indexOf('--limite');
  const limite = iLimite >= 0 ? Number(argv[iLimite + 1]) : undefined;

  const resumo = await sincronizarProfessores({ executar, limite });

  if (!executar) {
    logger.info('Rode com --executar (e --limite N para canário) para escrever.');
  }
  for (const f of resumo.falhas) logger.error(f, 'falha');

  await pgPool.end();
  if (resumo.falhas.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  logger.error({ error }, 'Falha no sync de professores');
  process.exit(1);
});
