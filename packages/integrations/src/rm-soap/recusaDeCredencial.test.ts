import { describe, expect, it } from 'vitest';
import { RmDataServerError, recusouCredencialDoRm } from './wsDataServerClient';

/**
 * A ÚNICA FALHA DO RM EM QUE INSISTIR FAZ MAL.
 *
 * ─── O FATO QUE ISTO EXISTE PARA RESPEITAR ──────────────────────────────────
 *
 * Medido em 29/09/2026, causando: SEIS autenticações inválidas seguidas
 * bloquearam o usuário da integração no RM. A senha do `.env` estava certa —
 * está provado pela leitura bem-sucedida das seis Sentenças um minuto antes.
 * O que bloqueou foi a repetição.
 *
 * O canário autentica seis vezes por ciclo, de hora em hora: 144 por dia. Sem
 * este predicado, um ciclo com a credencial recusada gasta as seis tentativas e
 * bloqueia o usuário — o vigia virando a causa do incidente que ele observa.
 *
 * ─── POR QUE NÃO SE CHAMA `status` ──────────────────────────────────────────
 *
 * `RmDataServerError` existe, entre outras coisas, para NÃO carregar `status`:
 * o Fastify usaria o campo como status da resposta da API, e um 401 do RM
 * virava "sessão expirada" na tela — seis logins em treze minutos, em
 * 21/09/2026, com a sessão viva o tempo todo.
 *
 * O nome diferente é o ponto: nenhum handler HTTP o confunde com um status, e
 * quem precisa da informação a encontra.
 */

describe('o campo estruturado', () => {
  it('RmDataServerError marcado é recusa de credencial', () => {
    expect(recusouCredencialDoRm(new RmDataServerError('x', 'GlbConsSQLData', true))).toBe(true);
  });

  it('RmDataServerError não marcado não é', () => {
    expect(recusouCredencialDoRm(new RmDataServerError('x', 'GlbConsSQLData', false))).toBe(false);
  });

  it('o default é `false` — na dúvida, NÃO é recusa de credencial', () => {
    // Fail-safe invertido de propósito: marcar recusa onde não há faria o
    // canário parar de vigiar por causa de um timeout. O custo dos dois erros
    // não é simétrico, mas o silêncio do canário é o que se está consertando.
    expect(recusouCredencialDoRm(new RmDataServerError('x', 'GlbConsSQLData'))).toBe(false);
  });

  it('Error simples com a marca anexada também conta', () => {
    // É a forma do `wsConsultaSqlClient`, que lança `Error` com `Object.assign`.
    const e = Object.assign(new Error('wsConsultaSQL falhou (TODDLE.FREQ) (HTTP 401): ...'), {
      recusouCredencial: true,
    });
    expect(recusouCredencialDoRm(e)).toBe(true);
  });

  /**
   * A marca vence a mensagem. Um erro marcado `false` cuja mensagem por acaso
   * contenha "(HTTP 401)" — repassando texto de outro sistema, por exemplo —
   * não deve parar o canário.
   */
  it('a marca explícita vence a leitura da mensagem', () => {
    const e = Object.assign(new Error('o RM devolveu isto: "(HTTP 401)" no corpo'), {
      recusouCredencial: false,
    });
    expect(recusouCredencialDoRm(e)).toBe(false);
  });
});

describe('a leitura da mensagem, como último recurso', () => {
  /**
   * Para erro que venha de um caminho ainda não marcado. Procura o texto que
   * os dois clientes SOAP deste repositório constroem — `(HTTP 401)` e
   * `(HTTP 403)`.
   */
  it('reconhece 401 pela mensagem', () => {
    expect(recusouCredencialDoRm(new Error('ReadRecord GlbConsSQLData falhou (HTTP 401): x'))).toBe(
      true,
    );
  });

  it('reconhece 403 pela mensagem', () => {
    expect(recusouCredencialDoRm(new Error('wsConsultaSQL falhou (X) (HTTP 403): x'))).toBe(true);
  });

  it('NÃO confunde com outros status', () => {
    for (const s of [400, 404, 429, 500, 502, 503]) {
      expect(recusouCredencialDoRm(new Error(`falhou (HTTP ${s}): x`)), `HTTP ${s}`).toBe(false);
    }
  });

  it('timeout não é recusa de credencial', () => {
    // Timeout é a falha que mais acontece, e parar o canário por ela seria
    // trocar o vigia por silêncio.
    expect(recusouCredencialDoRm(new Error('ECONNABORTED: timeout of 120000ms exceeded'))).toBe(
      false,
    );
  });

  it('erro de rede não é recusa de credencial', () => {
    expect(recusouCredencialDoRm(new Error('connect ECONNREFUSED 10.0.0.1:1951'))).toBe(false);
  });
});

describe('entradas degeneradas não derrubam nada', () => {
  // Este predicado roda dentro de um `catch`. Se ele mesmo lançar, o canário
  // morre no tratamento do erro — o pior lugar possível para um defeito.
  const casos: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['string', 'HTTP 401'],
    ['número', 401],
    ['objeto vazio', {}],
    ['objeto com message não-string', { message: 401 }],
    ['marca com tipo errado', { recusouCredencial: 'sim', message: '(HTTP 401)' }],
  ];
  for (const [nome, valor] of casos) {
    it(nome, () => {
      expect(() => recusouCredencialDoRm(valor)).not.toThrow();
    });
  }

  it('string solta com o texto NÃO conta — só objeto de erro', () => {
    expect(recusouCredencialDoRm('falhou (HTTP 401)')).toBe(false);
  });

  it('marca com tipo errado cai para a mensagem', () => {
    expect(recusouCredencialDoRm({ recusouCredencial: 'sim', message: 'x (HTTP 401)' })).toBe(true);
  });
});
