import { construirApp } from './app';
import { conferirCanalDeAviso, env, logger, tenantConfig } from '@rm-toddle/config';
import { apagarSessoesMortas, pgPool } from '@rm-toddle/db';

/** Config da escola atendida por este processo. Ver packages/config/src/tenantConfig.ts. */
const cfg = tenantConfig;

/** Entrypoint da API. Rodar com: npm run api */
async function main(): Promise<void> {
  /*
   * O estado do canal de aviso, ANTES de aceitar a primeira requisição.
   *
   * Se estiver cego, sai em nível `error` — que é o nível que sobrevive quando
   * alguém filtra `warn` em produção. Não impede o boot: um processo não pode
   * deixar de subir porque falta webhook, isso trocaria "falha sem aviso" por
   * "sem sistema nenhum".
   */
  conferirCanalDeAviso('api');

  const app = construirApp();
  await app.listen({ port: env.API_PORT, host: env.API_HOST });
  logger.info(
    { porta: env.API_PORT, host: env.API_HOST, authMode: env.API_AUTH_MODE, tenant: cfg.slug },
    'API no ar',
  );

  /*
   * Limpeza de sessões, aqui mesmo — sem cron nem infra nova.
   *
   * `.unref()` é o que permite o processo encerrar sem esperar o timer; sem ele
   * o desligamento gracioso ficaria pendurado até 24h.
   *
   * Roda uma vez no boot também: senão um processo reiniciado todo dia nunca
   * chegaria a limpar nada.
   */
  const limparSessoes = async (): Promise<void> => {
    try {
      const apagadas = await apagarSessoesMortas();
      if (apagadas > 0) logger.info({ apagadas }, 'Sessões mortas há mais de 7 dias removidas');
    } catch (erro) {
      logger.warn({ erro }, 'Limpeza de sessões falhou — tentará de novo amanhã');
    }
  };
  setInterval(() => void limparSessoes(), 24 * 60 * 60 * 1000).unref();
  void limparSessoes();

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
