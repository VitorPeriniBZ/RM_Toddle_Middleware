import { describe, expect, it } from 'vitest';
import {
  LIMITE_GLOBAL,
  SEM_LIMITE,
  isentaDeLimite,
  limiteParaRota,
} from './limitesDaApi';

/**
 * O QUE ESTE ARQUIVO DEFENDE.
 *
 * Um limitador com chave forjável é PIOR que limitador nenhum: dá sensação de
 * proteção e entrega um vetor de negação de serviço contra usuário específico.
 * Nesta topologia o `X-Forwarded-For` chega com a entrada mais à esquerda
 * controlada por quem chama — os dois proxies da frente ANEXAM em vez de
 * substituir. Por isso a chave é constante e o balde é único, e por isso estes
 * testes existem: para que "melhorar para por-IP" não passe sem alguém ver.
 */

describe('as rotas que o limitador não pode tocar', () => {
  /**
   * ─── A ARMADILHA QUE ISTO EVITA ────────────────────────────────────────
   *
   * O healthcheck do container bate em `/health` a cada 30s
   * (`docker-compose.coolify.yml:184`). Um 429 ali faria o Docker ler
   * "unhealthy" e **reiniciar o container**: o limitador derrubaria a
   * aplicação que veio proteger, e o sintoma (container em laço) não se parece
   * com a causa.
   */
  it.each(['/health', '/health/ready'])('%s fica fora do limitador', (rota) => {
    expect(isentaDeLimite(rota)).toBe(true);
    expect(limiteParaRota('GET', rota)).toBeNull();
  });

  it('qualquer outra rota NÃO é isenta', () => {
    expect(isentaDeLimite('/agenda')).toBe(false);
    expect(isentaDeLimite('/auth/sessao')).toBe(false);
  });

  it('a isenção é exata, não por prefixo', () => {
    // `/healthzinho` não existe, mas se existisse não herdaria a isenção.
    expect(isentaDeLimite('/healthzinho')).toBe(false);
  });
});

describe('teto próprio onde a rota custa caro', () => {
  it.each([
    ['POST', '/auth/sessao', 30, 'verifica o id_token no Google: chamada externa'],
    ['POST', '/sentencas/conferir', 10, 'lê as seis Sentenças no RM por SOAP'],
    ['POST', '/sentencas/restaurar', 5, 'ESCREVE Sentença no RM'],
  ])('%s %s -> %s/min (%s)', (metodo, caminho, max) => {
    expect(limiteParaRota(metodo, caminho)?.max).toBe(max);
  });

  /**
   * A rota que escreve no RM tem de ser a mais apertada das três. Não é
   * preferência: `restaurar` chama `GlbConsSQLData.SaveRecord` e muda o RM.
   */
  it('restaurar é mais apertada que conferir, que é mais que o login', () => {
    const r = limiteParaRota('POST', '/sentencas/restaurar')!.max;
    const c = limiteParaRota('POST', '/sentencas/conferir')!.max;
    const l = limiteParaRota('POST', '/auth/sessao')!.max;
    expect(r).toBeLessThan(c);
    expect(c).toBeLessThan(l);
  });

  /**
   * ─── POR MÉTODO E CAMINHO, NÃO POR PREFIXO ──────────────────────────────
   *
   * `GET /sentencas` lista o que já foi conferido e é barato; o `POST` de
   * mesmo prefixo fala com o RM. Limitar por prefixo puniria a leitura pelo
   * custo da escrita — e a tela faz a leitura a cada abertura.
   */
  it('o GET de mesmo prefixo NÃO herda o teto do POST', () => {
    expect(limiteParaRota('GET', '/sentencas')).toBeNull();
    expect(limiteParaRota('POST', '/sentencas/conferir')).not.toBeNull();
  });

  it('o método é comparado sem depender de caixa', () => {
    expect(limiteParaRota('post', '/sentencas/restaurar')?.max).toBe(5);
  });

  it('rota sem teto próprio cai no global', () => {
    expect(limiteParaRota('GET', '/agenda')).toBeNull();
    expect(limiteParaRota('POST', '/auth/sair')).toBeNull();
  });
});

describe('o teto global tem folga deliberada', () => {
  /**
   * O balde é ÚNICO (a chave é constante, porque não há identidade de cliente
   * confiável nesta topologia). Um número apertado aqui tiraria a escola do ar
   * junto com o atacante — a folga é a contrapartida de não poder separar
   * clientes.
   */
  it('fica uma ordem de grandeza acima do uso real de uma secretaria', () => {
    expect(LIMITE_GLOBAL.max).toBeGreaterThanOrEqual(300);
    expect(LIMITE_GLOBAL.timeWindow).toBe(60_000);
  });

  it('e ainda assim é finito — corta enxurrada', () => {
    expect(LIMITE_GLOBAL.max).toBeLessThanOrEqual(1_000);
  });

  it('todo teto por rota é MENOR que o global, senão não seria teto', () => {
    for (const rota of ['/auth/sessao', '/sentencas/conferir', '/sentencas/restaurar']) {
      expect(limiteParaRota('POST', rota)!.max).toBeLessThan(LIMITE_GLOBAL.max);
    }
  });

  it('a lista de isentas não cresceu sem alguém notar', () => {
    expect([...SEM_LIMITE].sort()).toEqual(['/health', '/health/ready']);
  });
});
