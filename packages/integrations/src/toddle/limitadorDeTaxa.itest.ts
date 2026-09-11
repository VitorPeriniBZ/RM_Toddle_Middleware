import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import IORedis from 'ioredis';
import { env, tenantConfig } from '@rm-toddle/config';
import {
  aguardarVagaNoToddle,
  cooldownRestanteMs,
  encerrarLimitador,
  registrarRateLimitDoToddle,
} from './limitadorDeTaxa';

/**
 * O limitador, contra Redis DE VERDADE.
 *
 * A parte arriscada é o script Lua: ele lê, decide e escreve ATOMICAMENTE. Feito
 * em três comandos separados, dois workers leem o mesmo saldo e ambos gastam —
 * que é exatamente o burst que este módulo existe para impedir, e um teste com
 * Redis falso jamais pegaria.
 *
 * A outra parte arriscada é temporal: "espaçou" e "travou" são a mesma coisa
 * para um mock. Aqui o tempo é medido.
 */
const chave = `toddle:rate:${tenantConfig.toddle.organizationId}`;
const redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 3 });

async function zerar(): Promise<void> {
  await redis.del(`${chave}:balde`, `${chave}:cooldown`);
}

beforeEach(zerar);
afterAll(async () => {
  await zerar();
  await redis.quit();
  await encerrarLimitador();
});

describe('limitador de taxa do Toddle', () => {
  it('não atrasa enquanto há saldo no balde', async () => {
    const t0 = Date.now();
    for (let i = 0; i < 10; i += 1) await aguardarVagaNoToddle('teste');
    // Generoso de propósito: o que se afirma é "não espaçou", não uma latência.
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('espaça na taxa de refil depois que o balde seca', async () => {
    const capacidade = env.TODDLE_RATE_LIMIT_MAX;
    const msPorToken = (env.TODDLE_RATE_LIMIT_JANELA_S * 1_000) / capacidade;

    // Seca o balde escrevendo direto — drenar chamando levaria a janela inteira.
    await redis.hset(`${chave}:balde`, 'tokens', 0, 'em', Date.now());

    const t0 = Date.now();
    await aguardarVagaNoToddle('depois-do-dreno');
    const esperou = Date.now() - t0;

    // Um token custa `msPorToken`. Margem larga para não ficar frágil em CI lenta.
    expect(esperou).toBeGreaterThan(msPorToken * 0.5);
    expect(esperou).toBeLessThan(msPorToken * 3);
  });

  it('um 429 cala todos até a janela informada pela própria API', async () => {
    await registrarRateLimitDoToddle(2);
    expect(await cooldownRestanteMs()).toBeGreaterThan(1_000);

    const t0 = Date.now();
    await aguardarVagaNoToddle('depois-do-429');
    const esperou = Date.now() - t0;

    expect(esperou).toBeGreaterThan(1_500);
    expect(esperou).toBeLessThan(4_000);
  });

  // Sem isto, os tokens acumulados durante o castigo fariam todos os fluxos
  // acordarem juntos e dispararem em rajada no instante em que ele expira —
  // abrindo a janela seguinte de 429 na hora.
  it('zera o balde ao entrar em cooldown', async () => {
    await redis.hset(`${chave}:balde`, 'tokens', env.TODDLE_RATE_LIMIT_MAX, 'em', Date.now());
    await registrarRateLimitDoToddle(1);
    expect(Number(await redis.hget(`${chave}:balde`, 'tokens'))).toBe(0);
  });

  // O primeiro 429 manda. Três chamadas levando 429 juntas não podem reiniciar
  // a janela três vezes, senão o castigo vira o triplo do que a API pediu.
  it('não reinicia a janela quando chegam vários 429 juntos', async () => {
    await registrarRateLimitDoToddle(10);
    const primeiro = await cooldownRestanteMs();
    await registrarRateLimitDoToddle(300);
    const depois = await cooldownRestanteMs();
    expect(depois).toBeLessThanOrEqual(primeiro);
  });
});
