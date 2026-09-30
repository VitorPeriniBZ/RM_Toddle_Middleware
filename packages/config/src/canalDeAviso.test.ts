import { beforeEach, describe, expect, it, vi } from 'vitest';
import { alertar, limparJanelaDeAlerta } from './alerta';
import { FLUXOS_COM_HEARTBEAT, diagnosticar, type UrlsDeAviso } from './canalDeAviso';
import { limparAvisosDeHeartbeat, pingHeartbeat } from './heartbeat';
import { logger } from './logger';

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
   * COMPORTAMENTO, não estrutura — e a distinção importa.
   *
   * A primeira versão destes testes lia o fonte com regex procurando
   * `if (!env.ALERTA_WEBHOOK_URL) return false;`. Funcionava, e era pior:
   * `if (...) { return false; }` com chaves, ou renomear a variável, passariam
   * calados com o defeito de volta. Falso VERDE num teste que existe para
   * impedir silêncio é a ironia mais cara possível.
   *
   * Aqui o defeito É observável: o que mudou não é o valor de retorno
   * (`alertar()` devolve `false` nos dois desenhos) e sim a EMISSÃO do log.
   * Espiar o logger observa exatamente isso.
   *
   * Em P0-1 o teste estrutural se justificou porque lá o defeito — duplicar a
   * fórmula da chave — NÃO tem sintoma comportamental: uma reimplementação de
   * saída idêntica passa por qualquer asserção sobre valores. Aqui tem sintoma.
   * Regra que fica: estrutural só quando o comportamento não denuncia.
   *
   * O ambiente da suíte unit não define `ALERTA_WEBHOOK_URL` (ver o bloco `env`
   * de vitest.workspace.ts), então "sem canal" é o estado natural aqui — não
   * precisa ser simulado.
   */

  beforeEach(() => {
    limparJanelaDeAlerta();
    limparAvisosDeHeartbeat();
    vi.restoreAllMocks();
  });

  it('alertar() sem canal grita em error, com o conteúdo do alerta', async () => {
    const espiao = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    const enviado = await alertar({
      assunto: 'Jobs parados na DLQ',
      contexto: { total: 62, fila: 'rm-to-toddle-students' },
    });

    expect(enviado, 'sem canal não há envio — isso não mudou').toBe(false);
    expect(
      espiao,
      'alertar() saiu calado sem canal. É o motivo de 62 jobs terem ficado sete dias na DLQ ' +
        'sem ninguém saber: o vigia encontrava o problema, chamava alertar(), e o alerta ' +
        'evaporava. Sem canal o conteúdo tem de ir para o log em error — degradado, não perdido.',
    ).toHaveBeenCalledTimes(1);

    const [dados, mensagem] = espiao.mock.calls[0] as [Record<string, unknown>, string];
    expect(dados.canal).toBe('DESLIGADO');
    expect(dados.contexto).toEqual({ total: 62, fila: 'rm-to-toddle-students' });
    // O conteúdo tem de estar na mensagem, não só nos campos: quem lê o log
    // agregado costuma ver a mensagem antes de expandir o objeto.
    expect(mensagem).toContain('Jobs parados na DLQ');
    expect(mensagem).toContain('ALERTA_WEBHOOK_URL');
  });

  it('pingHeartbeat() sem URL avisa que aquele fluxo não tem quem reclame', async () => {
    const espiao = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await pingHeartbeat(undefined, 'sucesso', { job: 'frequencia' });

    expect(
      espiao,
      'pingHeartbeat() saiu calado sem URL. Um fluxo sem heartbeat não tem quem reclame do ' +
        'silêncio dele — e o de frequência escreve falta no registro acadêmico.',
    ).toHaveBeenCalledTimes(1);

    const [dados, mensagem] = espiao.mock.calls[0] as [Record<string, unknown>, string];
    expect(dados.fluxo).toBe('frequencia');
    expect(dados.heartbeat).toBe('DESLIGADO');
    expect(mensagem).toContain('HEARTBEAT_URL_FREQUENCIA');
  });

  /**
   * O estrangulamento é o que impede o conserto de virar o próximo problema.
   *
   * O fluxo de notas roda a cada 15 minutos (`NOTA_SYNC_CRON`). Um warn por run
   * seriam ~96 linhas por dia por fluxo, num projeto cuja última crise foi
   * 6,3 GB de log repetido.
   */
  it('o aviso de heartbeat é estrangulado: 3 pings seguidos, 1 warn', async () => {
    const espiao = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await pingHeartbeat(undefined, 'sucesso', { job: 'notas' });
    await pingHeartbeat(undefined, 'sucesso', { job: 'notas' });
    await pingHeartbeat(undefined, 'falha', { job: 'notas' });

    expect(espiao).toHaveBeenCalledTimes(1);
  });

  it('o estrangulamento é POR FLUXO: quatro fluxos mudos são quatro avisos', async () => {
    const espiao = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    for (const fluxo of FLUXOS_COM_HEARTBEAT) {
      await pingHeartbeat(undefined, 'sucesso', { job: fluxo });
    }

    // Colapsar os quatro num aviso só esconderia três problemas distintos:
    // cada fluxo tem o próprio monitor e o próprio conserto.
    expect(espiao).toHaveBeenCalledTimes(FLUXOS_COM_HEARTBEAT.length);
  });

  /**
   * O log degradado também é estrangulado — senão o conserto vira o problema.
   *
   * Sem isto, os 62 jobs da DLQ virariam 62 linhas de `error` com contexto
   * inteiro, que é a mesma tempestade que a janela de envio existe para conter.
   */
  it('o log degradado é estrangulado: dois alertas iguais, um error', async () => {
    const espiao = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    await alertar({ assunto: 'Jobs parados na DLQ', contexto: { total: 1 } });
    await alertar({ assunto: 'Jobs parados na DLQ', contexto: { total: 2 } });

    expect(espiao).toHaveBeenCalledTimes(1);
  });

  it('assuntos diferentes não se suprimem: é repetição, não volume', async () => {
    const espiao = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    await alertar({ assunto: 'Jobs parados na DLQ' });
    await alertar({ assunto: 'Run(s) preso(s) em "executing"' });

    expect(espiao).toHaveBeenCalledTimes(2);
  });

  /**
   * ─── O QUE NÃO DÁ PARA TESTAR AQUI, E POR QUÊ ────────────────────────────
   *
   * `alertar()` mantém DOIS mapas de supressão: um do envio, um do log
   * degradado. A separação existe para que um alerta que nunca teve canal não
   * mexa na contabilidade de quem envia, e para que o caminho sem canal não
   * povoe um mapa que antes ficava vazio.
   *
   * Isso NÃO é observável nesta suíte, e a primeira versão deste arquivo tinha
   * um teste que fingia observar: ele passava igual com os dois mapas fundidos
   * num só — descoberto por mutação, não por leitura. O motivo é que
   * `env.ALERTA_WEBHOOK_URL` é lido na importação do módulo e a suíte unit
   * nunca o define; sem canal, o caminho de envio jamais executa, então não há
   * como ver se a janela dele foi tocada.
   *
   * Preferi remover o teste a deixá-lo: um teste que não pode falhar dá a
   * mesma sensação de cobertura de um que pode, e essa sensação é o que este
   * projeto inteiro está tentando desmontar. A separação fica justificada no
   * comentário de `alerta.ts` e coberta pela revisão, não por asserção falsa.
   */
});
