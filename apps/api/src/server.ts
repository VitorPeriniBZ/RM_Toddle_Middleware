import { construirApp } from './app';
import { env, logger, tenantConfig } from '@rm-toddle/config';
import { pgPool } from '@rm-toddle/db';

/** Config da escola atendida por este processo. Ver packages/config/src/tenantConfig.ts. */
const cfg = tenantConfig;

/** Entrypoint da API. Rodar com: npm run api */
async function main(): Promise<void> {
  const app = construirApp();
  await app.listen({ port: env.API_PORT, host: env.API_HOST });
  logger.info(
    { porta: env.API_PORT, host: env.API_HOST, authMode: env.API_AUTH_MODE, tenant: cfg.slug },
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
