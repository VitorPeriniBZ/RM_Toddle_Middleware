import { describe, expect, it } from 'vitest';
import { construirApp } from './app';

/**
 * OS CABEÇALHOS QUE O HELMET PÕE — E O QUE ELE NÃO PODE PÔR AQUI.
 *
 * `/health` serve de sonda porque é a única rota sem autenticação: o que se
 * mede é o que o plugin acrescenta a TODA resposta, não a rota em si.
 */

async function cabecalhosDe(url: string): Promise<Record<string, unknown>> {
  const app = construirApp();
  await app.ready();
  const r = await app.inject({ method: 'GET', url });
  await app.close();
  return r.headers as Record<string, unknown>;
}

describe('o helmet está no ar', () => {
  it.each([
    ['x-content-type-options', 'nosniff'],
    ['x-frame-options', 'SAMEORIGIN'],
    ['referrer-policy', 'no-referrer'],
  ])('%s = %s', async (header, valor) => {
    expect((await cabecalhosDe('/health'))[header]).toBe(valor);
  }, 20_000);

  it('HSTS presente, com um ano', async () => {
    expect(String((await cabecalhosDe('/health'))['strict-transport-security'])).toContain(
      'max-age=31536000',
    );
  }, 20_000);
});

describe('o que o helmet NÃO pode pôr nesta API', () => {
  /**
   * ─── POR QUE CORP FICA DE FORA ─────────────────────────────────────────
   *
   * O default `same-origin` quebraria o desenvolvimento: a UI roda no Vite em
   * `localhost:5173` e a API em `3333` — origens diferentes. Em produção as
   * duas são a mesma origem (o nginx serve `/api` no mesmo domínio), então o
   * header não protegeria nada lá e só derrubaria o fluxo aqui.
   */
  it('cross-origin-resource-policy NÃO é same-origin', async () => {
    expect((await cabecalhosDe('/health'))['cross-origin-resource-policy']).not.toBe(
      'same-origin',
    );
  }, 20_000);

  /**
   * CSP numa API que só devolve JSON é header morto — quem serve HTML é o
   * nginx do `web`, e a CSP que importa é a de lá.
   */
  it('não há Content-Security-Policy numa API JSON', async () => {
    expect((await cabecalhosDe('/health'))['content-security-policy']).toBeUndefined();
  }, 20_000);
});

describe('o CORS não regrediu', () => {
  /**
   * A allowlist com `credentials: true` é o que impede qualquer site aberto no
   * navegador de usar a sessão de quem está logado. Se algum dia `origin`
   * virar `"*"`, as duas coisas juntas seriam o convite — por isso a asserção
   * olha o par, não só um lado.
   */
  it('continua anunciando credenciais, e nunca com origem "*"', async () => {
    const h = await cabecalhosDe('/health');
    expect(h['access-control-allow-credentials']).toBe('true');
    expect(h['access-control-allow-origin']).not.toBe('*');
  }, 20_000);
});
