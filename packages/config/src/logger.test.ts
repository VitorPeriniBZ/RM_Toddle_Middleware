import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { serializarErro } from './logger';

/**
 * A senha do RM não pode voltar para o log.
 *
 * ─── O QUE ACONTECEU EM 21/09/2026 ──────────────────────────────────────────
 *
 * Um 401 do RM foi parar no `docker logs` da api como o objeto de erro do axios
 * INTEIRO: `config.auth.password` em texto claro e o `Authorization: Basic ...`
 * dentro de `request._header`, numa linha de ~50KB. Ninguém escreveu
 * `logger.error({ senha })` — o serializador padrão do pino copia toda
 * propriedade própria e enumerável do erro, e num `AxiosError` isso inclui
 * `config`, `request` e `response`.
 *
 * Por isso o teste não olha para uma linha de log específica: ele olha para o
 * SERIALIZADOR, que é o que decide o destino de todo `logger.*({ err })` deste
 * projeto — inclusive os que ainda não foram escritos.
 *
 * O erro daqui é construído à mão, com a forma exata que o axios produz, em vez
 * de importar o axios: o que se testa é a nossa reação à forma, não a
 * biblioteca.
 */

/** Um `AxiosError` como ele chega aqui — com o que não pode ser impresso. */
function erroDeAxios(): Error {
  const erro = new Error('Request failed with status code 401') as Error & Record<string, unknown>;
  erro.isAxiosError = true;
  erro.code = 'ERR_BAD_REQUEST';
  erro.status = 401;
  erro.config = {
    method: 'post',
    baseURL: 'https://escola.rm.cloudtotvs.com.br:1951/wsDataServer/IwsDataServer',
    url: '',
    auth: { username: 'integracao.toddle', password: 'SENHA-QUE-NAO-PODE-VAZAR' },
    headers: { Authorization: 'Basic aW50ZWdyYWNhby50b2RkbGU6U0VOSEE=' },
  };
  erro.request = { _header: 'POST /wsDataServer HTTP/1.1\r\nAuthorization: Basic aW50ZWdyYWNhby50b2RkbGU6U0VOSEE=\r\n' };
  erro.response = { status: 401, data: '<html>401</html>' };
  return erro;
}

/**
 * Roda um pino com O MESMO serializador do módulo, escrevendo em memória.
 *
 * O logger exportado decide transporte pelo NODE_ENV e escreve em stdout; o que
 * este teste precisa observar é a saída serializada, não o destino. Por isso o
 * `serializarErro` é exportado e montado aqui num destino próprio — se alguém
 * trocar o serializador no `logger`, o teste passa a testar o que passou a
 * valer, e não uma cópia que envelheceu.
 */
function linhasDe(fn: (log: pino.Logger) => void): string {
  const saida: string[] = [];
  const espelho = pino(
    { serializers: { err: serializarErro } },
    { write: (s: string) => saida.push(s) },
  );
  fn(espelho);
  return saida.join('');
}

describe('serializador de erro do logger', () => {
  it('não imprime a senha nem o header Basic de um erro de axios', () => {
    const saida = linhasDe((log) => log.error({ err: erroDeAxios() }, 'RM recusou'));

    expect(saida).not.toContain('SENHA-QUE-NAO-PODE-VAZAR');
    expect(saida).not.toContain('Basic ');
    expect(saida).not.toContain('_header');
  });

  it('mantém o que serve para diagnosticar: mensagem, código, status e URL', () => {
    const saida = linhasDe((log) => log.error({ err: erroDeAxios() }, 'RM recusou'));
    const linha = JSON.parse(saida.trim().split('\n')[0]) as { err: Record<string, unknown> };

    expect(linha.err).toMatchObject({
      type: 'AxiosError',
      message: 'Request failed with status code 401',
      code: 'ERR_BAD_REQUEST',
      status: 401,
      metodo: 'POST',
    });
    expect(String(linha.err.url)).toContain('wsDataServer');
  });

  /**
   * O erro comum continua com stack: trocar o serializador padrão por um que só
   * entende axios cegaria todo o resto do projeto.
   */
  it('não estraga o erro comum — stack continua lá', () => {
    const saida = linhasDe((log) => log.error({ err: new Error('falhou por outro motivo') }, 'x'));
    const linha = JSON.parse(saida.trim().split('\n')[0]) as { err: { stack?: string; message?: string } };

    expect(linha.err.message).toBe('falhou por outro motivo');
    expect(linha.err.stack).toContain('logger.test.ts');
  });
});
