import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FLUXOS_COM_HEARTBEAT, diagnosticar, type UrlsDeAviso } from './canalDeAviso';

/**
 * UM MONITOR DESLIGADO NÃO PODE SER SILENCIOSO SOBRE ESTAR DESLIGADO.
 *
 * ─── O DEFEITO QUE ISTO PEGA ────────────────────────────────────────────────
 *
 * Havia três mecanismos de aviso bem desenhados — heartbeat, webhook e vigia —
 * e os três estavam mudos, porque nenhuma URL estava configurada. As duas linhas
 * responsáveis:
 *
 *   alerta.ts       if (!env.ALERTA_WEBHOOK_URL) return false;
 *   heartbeat.ts    if (!url) return;
 *
 * As duas comentadas como "não configurado = desligado, de propósito". A
 * intenção era não obrigar quem roda local a montar um webhook; o efeito foi que
 * o vigia rodava, encontrava o problema, chamava `alertar()`, e `alertar()`
 * devolvia `false` sem dizer nada. Toda vez.
 *
 * Foi assim que 62 jobs ficaram sete dias parados na DLQ, e assim que um worker
 * martelou um Redis morto por treze dias produzindo 6,3 GB de log.
 *
 * O que estes testes travam não é "tem de haver webhook" — continua legítimo
 * rodar sem. É que a ausência tem de ser VISÍVEL.
 */

/** Nenhuma URL: o estado que este módulo existe para deixar de ser silencioso. */
const nada: UrlsDeAviso = { heartbeats: {} };

/** Tudo configurado. */
const tudo: UrlsDeAviso = {
  alerta: 'https://hooks.exemplo/servico/xyz',
  heartbeats: {
    alunos: 'https://hc.exemplo/1',
    professores: 'https://hc.exemplo/2',
    notas: 'https://hc.exemplo/3',
    frequencia: 'https://hc.exemplo/4',
  },
};

describe('cegueira total', () => {
  it('sem nenhuma URL, o diagnóstico é CEGO', () => {
    expect(diagnosticar(nada).cego).toBe(true);
  });

  it('o resumo diz o que fazer, não só que está errado', () => {
    const { resumo } = diagnosticar(nada);
    // Quem lê isto às 3h da manhã precisa do nome da variável, não de um adjetivo.
    expect(resumo).toContain('ALERTA_WEBHOOK_URL');
    expect(resumo).toContain('HEARTBEAT_URL_');
  });

  it('lista todas as variáveis que faltam', () => {
    expect(diagnosticar(nada).faltando).toEqual([
      'ALERTA_WEBHOOK_URL',
      'HEARTBEAT_URL_ALUNOS',
      'HEARTBEAT_URL_PROFESSORES',
      'HEARTBEAT_URL_NOTAS',
      'HEARTBEAT_URL_FREQUENCIA',
    ]);
  });

  /**
   * A ordem não é alfabética e não é acidental: `ALERTA_WEBHOOK_URL` sozinha já
   * tira o sistema da cegueira total, porque cobre DLQ e vigia — os dois modos
   * de falha com o processo VIVO, que são os que mais acontecem aqui. Quem for
   * configurar uma coisa só deve configurar essa.
   */
  it('ALERTA_WEBHOOK_URL vem primeiro na lista do que falta', () => {
    expect(diagnosticar(nada).faltando[0]).toBe('ALERTA_WEBHOOK_URL');
  });
});

describe('configuração completa', () => {
  it('com tudo configurado, não está cego e nada falta', () => {
    const d = diagnosticar(tudo);
    expect(d.cego).toBe(false);
    expect(d.faltando).toEqual([]);
    expect(d.alerta).toBe('ativo');
  });

  it('todos os heartbeats aparecem como ativos', () => {
    const d = diagnosticar(tudo);
    for (const fluxo of FLUXOS_COM_HEARTBEAT) expect(d.heartbeats[fluxo]).toBe('ativo');
  });
});

describe('configuração parcial — o estado mais perigoso de todos', () => {
  /**
   * Parcial é pior que nada, e é por isso que tem bloco próprio.
   *
   * Cegueira total é óbvia quando alguém procura. Parcial dá a sensação de que
   * "o alerta está configurado", e ninguém repara que o fluxo de FREQUÊNCIA —
   * o que escreve falta no registro acadêmico — é justamente o que não tem
   * quem reclame do silêncio dele.
   */
  it('só o webhook: não está cego, mas os 4 heartbeats faltam', () => {
    const d = diagnosticar({ alerta: 'https://hooks.exemplo/xyz', heartbeats: {} });
    expect(d.cego).toBe(false);
    expect(d.alerta).toBe('ativo');
    expect(d.faltando).toHaveLength(4);
    expect(d.resumo).toContain('PARCIAL');
  });

  it('só um heartbeat: não está cego, e o resumo conta quantos', () => {
    const d = diagnosticar({ heartbeats: { frequencia: 'https://hc.exemplo/4' } });
    expect(d.cego).toBe(false);
    expect(d.alerta).toBe('DESLIGADO');
    expect(d.resumo).toContain('1 de 4');
    expect(d.resumo).toContain('webhook DESLIGADO');
  });

  it('o fluxo configurado e o não configurado são distinguíveis um a um', () => {
    const d = diagnosticar({ heartbeats: { frequencia: 'https://hc.exemplo/4' } });
    expect(d.heartbeats.frequencia).toBe('ativo');
    expect(d.heartbeats.notas).toBe('DESLIGADO');
    expect(d.heartbeats.alunos).toBe('DESLIGADO');
    expect(d.heartbeats.professores).toBe('DESLIGADO');
  });
});

describe('o que conta como "configurado"', () => {
  /**
   * String vazia e espaço em branco são o caso REAL, não teórico.
   *
   * O `.env.example` deste projeto lista variáveis com `=` e nada depois, e o
   * Zod de `env.ts` transforma `''` em `undefined` para vários campos — mas não
   * para todos, e um `.env` copiado à mão facilmente vira `ALERTA_WEBHOOK_URL= `.
   * Tratar isso como "configurado" reconstrói o silêncio exatamente onde este
   * módulo o está removendo.
   */
  it('string vazia NÃO conta como configurado', () => {
    expect(diagnosticar({ alerta: '', heartbeats: {} }).alerta).toBe('DESLIGADO');
  });

  it('só espaço NÃO conta como configurado', () => {
    expect(diagnosticar({ alerta: '   ', heartbeats: {} }).alerta).toBe('DESLIGADO');
  });

  it('undefined explícito no heartbeat NÃO conta como configurado', () => {
    const d = diagnosticar({ heartbeats: { notas: undefined } });
    expect(d.heartbeats.notas).toBe('DESLIGADO');
  });

  it('cegueira total continua cega quando as URLs são strings vazias', () => {
    const d = diagnosticar({
      alerta: '',
      heartbeats: { alunos: '', professores: '  ', notas: undefined, frequencia: '' },
    });
    expect(d.cego).toBe(true);
  });
});

describe('o resumo nunca é vazio', () => {
  // Um diagnóstico sem frase é um log sem informação. Vale para os três estados.
  const casos: Array<[string, UrlsDeAviso]> = [
    ['cego', nada],
    ['parcial', { alerta: 'https://hooks.exemplo/xyz', heartbeats: {} }],
    ['completo', tudo],
  ];
  for (const [nome, urls] of casos) {
    it(nome, () => expect(diagnosticar(urls).resumo.length).toBeGreaterThan(20));
  }
});

// ─── AS DUAS LINHAS QUE NÃO PODEM VOLTAR ────────────────────────────────────

describe('o retorno silencioso não volta', () => {
  /**
   * Teste estrutural, mesmo espírito de `suiteSerializada.test.ts`.
   *
   * O defeito aqui não é um valor errado: é uma AUSÊNCIA de log. Nenhum teste de
   * comportamento sobre o valor de retorno pega isso — `alertar()` devolve
   * `false` nos dois desenhos, o antigo e o novo. O que mudou é o que acontece
   * ANTES do `return`, e é isso que estas asserções protegem.
   *
   * Comentários saem antes: o cabeçalho dos dois módulos CITA as linhas antigas
   * para explicar por que elas saíram, e sem tirar comentário o teste acusaria
   * a própria explicação.
   */
  const semComentarios = (arquivo: string): string =>
    readFileSync(resolve(__dirname, arquivo), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

  it('alerta.ts não volta a sair calado quando falta a URL', () => {
    expect(
      semComentarios('alerta.ts'),
      'voltou o `if (!env.ALERTA_WEBHOOK_URL) return false;` sem log. Esse retorno é o motivo ' +
        'de 62 jobs terem ficado sete dias na DLQ sem ninguém saber: o vigia encontrava o ' +
        'problema, chamava alertar(), e o alerta evaporava. Quando não há canal, o conteúdo do ' +
        'alerta tem de ir para o log em nível error — degradado, nunca perdido.',
    ).not.toMatch(/if\s*\(\s*!env\.ALERTA_WEBHOOK_URL\s*\)\s*return\s+false\s*;/);
  });

  it('heartbeat.ts não volta a sair calado quando falta a URL', () => {
    expect(
      semComentarios('heartbeat.ts'),
      'voltou o `if (!url) return;` sem log. Um fluxo sem heartbeat não tem quem reclame do ' +
        'silêncio dele, e isso precisa aparecer em vez de ser presumido.',
    ).not.toMatch(/if\s*\(\s*!url\s*\)\s*return\s*;/);
  });
});
