import { describe, expect, it } from 'vitest';
import { hashDoPayload } from './payloadHash';

/**
 * Este hash decide se um aluno é escrito ou não no Toddle. Os dois erros que ele
 * pode cometer são silenciosos e opostos:
 *
 *   hash muda sem o conteúdo mudar  -> escreve tudo toda vez, e a economia some
 *                                      sem nenhum sinal (é o comportamento que
 *                                      existia antes, só que agora disfarçado)
 *   hash igual com conteúdo diferente -> uma mudança de verdade nunca chega ao
 *                                      Toddle, e ninguém fica sabendo
 *
 * O primeiro é o que a ordem de chaves causaria; o segundo é o que um "hash"
 * frouxo demais (ignorar null, achatar aninhado) causaria.
 */

describe('hashDoPayload', () => {
  it('não depende da ordem em que o objeto foi montado', () => {
    const a = { firstName: 'Ana', lastName: 'Souza', email: 'ana@escola.br' };
    const b = { email: 'ana@escola.br', lastName: 'Souza', firstName: 'Ana' };
    expect(hashDoPayload(a)).toBe(hashDoPayload(b));
  });

  it('ordena também dentro de objeto aninhado', () => {
    expect(hashDoPayload({ x: { a: 1, b: 2 } })).toBe(hashDoPayload({ x: { b: 2, a: 1 } }));
  });

  it('muda quando qualquer valor muda', () => {
    const base = { firstName: 'Ana', lastName: 'Souza' };
    expect(hashDoPayload({ ...base, lastName: 'Souza Lima' })).not.toBe(hashDoPayload(base));
  });

  /**
   * "Campo ausente" e "campo explicitamente vazio" são coisas diferentes para
   * uma API: o segundo APAGA o valor no destino. Confundir os dois esconderia
   * uma escrita de verdade.
   */
  it('distingue campo ausente de campo nulo', () => {
    expect(hashDoPayload({ email: null })).not.toBe(hashDoPayload({}));
  });

  it('trata `undefined` como ausente, igual ao JSON', () => {
    expect(hashDoPayload({ email: undefined, nome: 'Ana' })).toBe(hashDoPayload({ nome: 'Ana' }));
  });

  /** Em payload, ordem de lista é conteúdo — ordenar aqui apagaria diferença. */
  it('NÃO ordena array', () => {
    expect(hashDoPayload({ tags: ['a', 'b'] })).not.toBe(hashDoPayload({ tags: ['b', 'a'] }));
  });

  it('não confunde o número 1 com a string "1"', () => {
    expect(hashDoPayload({ v: 1 })).not.toBe(hashDoPayload({ v: '1' }));
  });

  it('é estável entre execuções — é isso que permite comparar com o que foi gravado', () => {
    const payload = { firstName: 'Ana', lastName: 'Souza', email: 'ana@escola.br', gender: 'F' };
    expect(hashDoPayload(payload)).toBe(hashDoPayload({ ...payload }));
    expect(hashDoPayload(payload)).toMatch(/^[0-9a-f]{64}$/);
  });
});
