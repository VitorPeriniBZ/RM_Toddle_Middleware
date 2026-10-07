import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { SALTOS_CONFIAVEIS } from './limitesDaApi';

/**
 * A DIFERENÇA ENTRE `1` E `true` NÃO PRODUZ ERRO — SÓ MUDA QUEM PODE MENTIR.
 *
 * ─── A CADEIA REAL, MEDIDA EM 05/10/2026 ───────────────────────────────────
 *
 *     cliente -> borda -> proxy interno -> nginx -> api
 *
 * Os dois proxies da frente **anexam** ao `X-Forwarded-For` em vez de
 * substituir (`apps/web/nginx.conf:26` usa `$proxy_add_x_forwarded_for`, e a
 * borda também anexa). Então o que chega à API é:
 *
 *     X-Forwarded-For: <o que o cliente mandou>, <borda>, <proxy interno>
 *
 * Com `trustProxy: true`, o `req.ip` vira a primeira entrada — a do cliente —
 * e o limitador passa a ser comandado por quem ele deveria limitar. Pior:
 * forjar o XFF de outra pessoa esgota a cota DELA.
 *
 * Estes testes caracterizam o comportamento do `proxy-addr` (a biblioteca que
 * o Fastify usa) com a cadeia REAL, porque é desse comportamento que a decisão
 * depende. Não é teste de biblioteca por esporte: é a prova de que `1` faz o
 * que o cabeçalho de `limitesDaApi.ts` afirma que faz.
 */

/** A cadeia que chega à API quando alguém forja o próprio XFF. */
const XFF_FORJADO = '9.9.9.9, 172.70.1.1, 10.0.0.2';

async function ipVistoPeloFastify(trustProxy: boolean | number): Promise<string> {
  const app = Fastify({ trustProxy });
  app.get('/sonda', (req) => ({ ip: req.ip }));
  const r = await app.inject({
    method: 'GET',
    url: '/sonda',
    headers: { 'x-forwarded-for': XFF_FORJADO },
  });
  await app.close();
  return (r.json() as { ip: string }).ip;
}

describe('o XFF forjado NÃO vira a identidade do cliente', () => {
  it('com `true`, o valor forjado PASSA — é o que não se pode fazer', async () => {
    expect(await ipVistoPeloFastify(true)).toBe('9.9.9.9');
  });

  /**
   * A asserção central do item. Com um salto confiável, o `req.ip` é a entrada
   * mais à DIREITA — posta pelo nginx, que o cliente não alcança.
   */
  it('com SALTOS_CONFIAVEIS, o valor forjado é IGNORADO', async () => {
    const ip = await ipVistoPeloFastify(SALTOS_CONFIAVEIS);
    expect(ip).not.toBe('9.9.9.9');
    expect(ip).toBe('10.0.0.2');
  });

  it('e o valor resultante não muda quando o forjado muda', async () => {
    const app = Fastify({ trustProxy: SALTOS_CONFIAVEIS });
    app.get('/sonda', (req) => ({ ip: req.ip }));
    const um = await app.inject({
      url: '/sonda',
      headers: { 'x-forwarded-for': '1.1.1.1, 172.70.1.1, 10.0.0.2' },
    });
    const dois = await app.inject({
      url: '/sonda',
      headers: { 'x-forwarded-for': '2.2.2.2, 172.70.1.1, 10.0.0.2' },
    });
    await app.close();
    expect((um.json() as { ip: string }).ip).toBe((dois.json() as { ip: string }).ip);
  });
});

describe('a constante é o que o app usa', () => {
  /**
   * `true` é `1` para o TypeScript num campo `boolean | number`, e nenhum
   * compilador reclamaria da troca. Só esta asserção reclama.
   */
  it('SALTOS_CONFIAVEIS é um número, não `true`', () => {
    expect(typeof SALTOS_CONFIAVEIS).toBe('number');
    expect(SALTOS_CONFIAVEIS).toBe(1);
  });
});
