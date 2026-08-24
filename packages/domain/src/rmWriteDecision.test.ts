import { describe, expect, it } from 'vitest';
import {
  decidirEscrita,
  hashValor,
  resumirDecisoes,
  type EstadoNoRm,
  type Proveniencia,
  type Veredito,
} from './rmWriteDecision';

/**
 * A regra que impede a integração de apagar trabalho humano.
 *
 * ─── POR QUE ESTE ARQUIVO É O MAIS IMPORTANTE DA SUÍTE ──────────────────────
 *
 * Um erro aqui não aparece como exceção nem como log. Aparece como ausência
 * apagada no diário de um aluno, ou conteúdo de aula de um professor
 * sobrescrito — semanas depois, sem rastro, num sistema que é registro
 * acadêmico. É a classe de defeito que nenhum monitor pega, e por isso a única
 * defesa é cobertura sobre o espaço de estados.
 *
 * Do outro lado da escrita existem 21.300 ausências, ~10.000 notas e 12.166
 * conteúdos de aula lançados à mão, e o `SaveRecord` do RM é upsert que **não
 * diz se inseriu ou atualizou**.
 */

/** Como a leitura do RM entrega uma linha que a INTEGRAÇÃO criou. */
const daIntegracao = (valor: string, tocadaDepois = false): EstadoNoRm => ({
  valor,
  autoriaEhIntegracao: true,
  tocadaDepoisDeCriada: tocadaDepois,
});

/** Como entrega uma linha que um HUMANO criou. */
const deHumano = (valor: string): EstadoNoRm => ({ valor, autoriaEhIntegracao: false });

const nosso = (valor: string): Proveniencia => ({
  payloadHash: hashValor(valor),
  escritoEm: '2026-08-20T03:00:00.000Z',
});

const decide = (
  desejado: string | null,
  noRm: EstadoNoRm | null,
  prov: Proveniencia | null = null,
): Veredito => decidirEscrita({ chaveNatural: 'k', valor: desejado }, noRm, prov).veredito;

describe('caminho normal', () => {
  it('escreve quando o RM está vazio e nunca escrevemos', () => {
    expect(decide('A', null)).toBe('ESCREVER_NOVO');
  });

  it.each([
    ['string vazia', ''],
    ['só espaço', '   '],
  ])('trata %s no RM como ausente', (_, valorRm) => {
    expect(decide('A', { valor: valorRm })).toBe('ESCREVER_NOVO');
  });

  it('não gasta chamada quando o RM já tem o mesmo valor', () => {
    expect(decide('A', { valor: 'A' })).toBe('NADA_A_FAZER');
  });

  it('atualiza quando a linha é nossa, está intacta, e a origem mudou', () => {
    expect(decide('Revisão de frações', { valor: 'Frações' }, nosso('Frações'))).toBe(
      'ATUALIZAR_NOSSO',
    );
  });

  it('reescreve quando escrevemos antes e o RM está vazio agora', () => {
    expect(decide('A', { valor: null }, nosso('A'))).toBe('ESCREVER_NOVO');
  });
});

describe('proteção do trabalho humano', () => {
  it('recusa quando o RM tem valor de humano e não temos proveniência', () => {
    expect(decide('A', deHumano('P'))).toBe('CONFLITO_HUMANO');
  });

  it('recusa quando a autoria é DESCONHECIDA — fail-closed', () => {
    // Sem `autoriaEhIntegracao`, a única resposta segura é não tocar.
    expect(decide('A', { valor: 'P' })).toBe('CONFLITO_HUMANO');
  });

  it('recusa quando a proveniência é nossa mas o RM tem outro valor', () => {
    expect(decide('Frações', deHumano('Frações e decimais'), nosso('Frações'))).toBe(
      'EDITADO_POR_FORA',
    );
  });

  it('recusa quando a integração criou MAS alguém tocou depois', () => {
    // Tecnicamente a linha é nossa. Mas a edição é mais recente e é humana —
    // quem mexeu por último manda.
    expect(decide('A', daIntegracao('P', true))).toBe('EDITADO_POR_FORA');
  });
});

describe('remoção nunca é inferida', () => {
  it('pede humano quando saiu do Toddle mas existe no RM', () => {
    // Remoção de falta tem efeito legal e de comunicação com a família.
    expect(decide(null, daIntegracao('A'), nosso('A'))).toBe('REMOCAO_PEDE_HUMANO');
  });

  it.each([
    ['o RM também não tem', { valor: null }],
    ['o RM nunca teve', null],
  ])('não faz nada quando saiu do Toddle e %s', (_, noRm) => {
    expect(decide(null, noRm as EstadoNoRm | null)).toBe('NADA_A_FAZER');
  });
});

describe('recuperação após restauração do NOSSO banco', () => {
  // Sem este caminho, restaurar o Poststgres faria a integração ver todo o
  // próprio trabalho anterior como conflito humano e parar o sync inteiro.
  it('aceita a autoria do RM quando a proveniência local foi perdida', () => {
    expect(decide('A', daIntegracao('P'))).toBe('ATUALIZAR_NOSSO');
  });

  it('explica o motivo, para o log não ficar mudo', () => {
    const d = decidirEscrita({ chaveNatural: 'k', valor: 'A' }, daIntegracao('P'), null);
    expect(d.porque).toMatch(/sem proveniência local/i);
  });
});

describe('normalização do hash', () => {
  // Sem normalizar, o RM devolveria whitespace que o Toddle não usa e todo
  // NADA_A_FAZER viraria escrita perpétua.
  it.each([
    ['espaço nas pontas', 'Frações', ' Frações '],
    ['espaço interno colapsado', 'a b', 'a  b'],
    ['CRLF do RM == LF do Toddle', 'a\nb', 'a\r\nb'],
    ['null e vazio', null, ''],
  ])('%s hasheia igual', (_, a, b) => {
    expect(hashValor(a)).toBe(hashValor(b as string));
  });

  it('valores diferentes hasheiam diferente', () => {
    expect(hashValor('A')).not.toBe(hashValor('P'));
  });

  it('não vira escrita perpétua por causa de um espaço', () => {
    expect(decide('Frações', { valor: 'Frações ' }, nosso('Frações'))).toBe('NADA_A_FAZER');
  });
});

describe('invariantes', () => {
  const AUTORIZADOS: Veredito[] = ['ESCREVER_NOVO', 'ATUALIZAR_NOSSO'];
  const PENDENTES: Veredito[] = ['CONFLITO_HUMANO', 'EDITADO_POR_FORA', 'REMOCAO_PEDE_HUMANO'];

  const amostras: Array<[string, string | null, EstadoNoRm | null, Proveniencia | null]> = [
    ['novo', 'A', null, null],
    ['idêntico', 'A', { valor: 'A' }, null],
    ['conflito', 'A', deHumano('P'), null],
    ['editado por fora', 'A', deHumano('P'), nosso('Z')],
    ['nosso e intacto', 'A', deHumano('P'), nosso('P')],
    ['autoria do RM', 'A', daIntegracao('P'), null],
    ['nosso, tocado depois', 'A', daIntegracao('P', true), null],
    ['remoção', null, { valor: 'A' }, nosso('A')],
    ['remoção sem alvo', null, null, null],
  ];

  it.each(amostras)('%s: podeEscrever só nos vereditos autorizados', (_, v, r, p) => {
    const d = decidirEscrita({ chaveNatural: 'k', valor: v }, r, p);
    expect(d.podeEscrever).toBe(AUTORIZADOS.includes(d.veredito));
  });

  it.each(amostras)('%s: pendencia só nos vereditos que pedem humano', (_, v, r, p) => {
    const d = decidirEscrita({ chaveNatural: 'k', valor: v }, r, p);
    expect(d.pendencia).toBe(PENDENTES.includes(d.veredito));
  });

  it.each(amostras)('%s: nunca é escrever E pendência ao mesmo tempo', (_, v, r, p) => {
    const d = decidirEscrita({ chaveNatural: 'k', valor: v }, r, p);
    expect(d.podeEscrever && d.pendencia).toBe(false);
  });

  it.each(amostras)('%s: sempre explica o motivo', (_, v, r, p) => {
    const d = decidirEscrita({ chaveNatural: 'k', valor: v }, r, p);
    expect(d.porque.length).toBeGreaterThan(10);
  });
});

describe('resumirDecisoes', () => {
  it('conta o total e separa escritas de pendências', () => {
    const ds = [
      decidirEscrita({ chaveNatural: 'a', valor: 'A' }, null, null),
      decidirEscrita({ chaveNatural: 'b', valor: 'A' }, deHumano('P'), null),
      decidirEscrita({ chaveNatural: 'c', valor: 'A' }, { valor: 'A' }, null),
    ];
    const r = resumirDecisoes(ds);
    expect(r.total).toBe(3);
    expect(r.aEscrever).toBe(1);
    expect(r.pendencias).toBe(1);
    expect(r.porVeredito).toEqual({
      ESCREVER_NOVO: 1,
      CONFLITO_HUMANO: 1,
      NADA_A_FAZER: 1,
    });
  });

  it('aguenta lista vazia', () => {
    expect(resumirDecisoes([])).toEqual({
      total: 0,
      porVeredito: {},
      aEscrever: 0,
      pendencias: 0,
    });
  });
});
