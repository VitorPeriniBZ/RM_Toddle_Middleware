import { construirApp } from './app';
import { env, logger } from '@rm-toddle/config';
import { pgPool } from '@rm-toddle/db';

/** Entrypoint da API. Rodar com: npm run api */
async function main(): Promise<void> {
  const app = construirApp();
  await app.listen({ port: env.API_PORT, host: env.API_HOST });
  logger.info(
    { porta: env.API_PORT, host: env.API_HOST, authMode: env.API_AUTH_MODE, tenant: env.TENANT_SLUG },
    'API no ar',
  );

  const encerrar = async (sinal: string): Promise<void> => {
    logger.info({ sinal }, 'Encerrando API...');
    await app.close();
    await pgPool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void encerrar('SIGINT'));
  process.on('SIGTERM', () => void encerrar('SIGTERM'));
}

main().catch((erro) => {
  logger.error({ erro }, 'Falha ao subir a API');
  process.exit(1);
});
