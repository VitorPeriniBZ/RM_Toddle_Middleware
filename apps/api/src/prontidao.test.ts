import { describe, expect, it } from 'vitest';
import {
  PRAZO_DA_CHECAGEM_MS,
  assuntoDeDependenciaFora,
  assuntoDeDependenciaVoltou,
  avaliarProntidao,
  comPrazo,
  transicoes,
  type DependenciaAvaliada,
} from './prontidao';

/**
 * OS PRIMEIROS TESTES DE `apps/api`.
 *
 * Até 29/09/2026 os três `apps/` somavam 15.788 linhas e nenhuma asserção. A
 * suíte `unit` nem sequer os enxergava — o `include` do
 * `vitest.workspace.ts` cobria só `packages/*`.
 *
 * O que torna `avaliarProntidao` testável aqui é ela não fazer I/O: recebe o
 * estado das dependências JÁ LIDO e devolve a decisão. Mesma escolha de
 * `decidirEscrita` e `diagnosticar` — a regra num lugar puro, o acesso ao
 * mundo em outro. É o que permite testar "o Postgres caiu" sem derrubar um
 * Postgres.
 */

const dep = (nome: string, estado: DependenciaAvaliada['estado']): DependenciaAvaliada => ({
  nome,
  estado,
});

describe('tudo no ar', () => {
  it('duas dependências ok: pronto, 200', () => {
    const r = avaliarProntidao([dep('postgres', 'ok'), dep('toddle', 'ok')]);
    expect(r.pronto).toBe(true);
    expect(r.status).toBe(200);
    expect(r.fora).toEqual([]);
  });

  it('lista vazia é pronto — não há do que depender', () => {
    expect(avaliarProntidao([]).status).toBe(200);
  });
});

describe('dependência FORA derruba a prontidão', () => {
  it('postgres fora: 503', () => {
    const r = avaliarProntidao([dep('postgres', 'falha'), dep('toddle', 'ok')]);
    expect(r.pronto).toBe(false);
    expect(r.status).toBe(503);
    expect(r.fora).toEqual(['postgres']);
  });

  it('toddle fora: 503', () => {
    expect(avaliarProntidao([dep('postgres', 'ok'), dep('toddle', 'falha')]).status).toBe(503);
  });

  it('as duas fora: 503, e as duas são nomeadas', () => {
    const r = avaliarProntidao([dep('postgres', 'falha'), dep('toddle', 'falha')]);
    expect(r.status).toBe(503);
    expect(r.fora).toEqual(['postgres', 'toddle']);
  });
});

describe('DEGRADADO não é FORA — a regra que mais se erra aqui', () => {
  /**
   * O Toddle responde 429 com janela de 300s quando pedimos demais. Até 11/09
   * este projeto tratava isso como queda, e a tela dizia "1 FORA DO AR" — o
   * Toddle estava de pé.
   *
   * Um 503 por rate limit repetiria a mentira com consequência maior: o monitor
   * externo pagina alguém de madrugada por uma janela que passa sozinha em
   * cinco minutos. Alarme falso é como um canal de alerta morre — e este
   * projeto acabou de construir um canal.
   */
  it('toddle limitado NÃO derruba a prontidão', () => {
    const r = avaliarProntidao([dep('postgres', 'ok'), dep('toddle', 'limitado')]);
    expect(r.pronto).toBe(true);
    expect(r.status).toBe(200);
  });

  it('mas aparece como degradado, para quem lê saber que existe', () => {
    const r = avaliarProntidao([dep('postgres', 'ok'), dep('toddle', 'limitado')]);
    expect(r.degradadas).toEqual(['toddle']);
    expect(r.fora).toEqual([]);
  });

  it('degradado junto com fora: o 503 é do FORA, e os dois aparecem', () => {
    const r = avaliarProntidao([dep('postgres', 'falha'), dep('toddle', 'limitado')]);
    expect(r.status).toBe(503);
    expect(r.fora).toEqual(['postgres']);
    expect(r.degradadas).toEqual(['toddle']);
  });

  it('todas limitadas ainda é 200', () => {
    const r = avaliarProntidao([dep('postgres', 'limitado'), dep('toddle', 'limitado')]);
    expect(r.status).toBe(200);
  });
});

describe('o corpo público não vaza detalhe operacional', () => {
  /**
   * Contrato herdado do P0-2: postura exposta a chamador anônimo não se recolhe
   * depois. O texto do erro de uma dependência carrega host, porta e mensagem
   * interna — `connect ECONNREFUSED 10.0.1.5:5432` nomeia a topologia da rede.
   *
   * `avaliarProntidao` recebe só `{nome, estado}` justamente para que não haja
   * de onde vazar: o tipo torna o erro impossível, em vez de confiar em quem
   * escreve a rota lembrar de filtrar.
   */
  it('cada dependência sai com nome e estado, e nada além disso', () => {
    const r = avaliarProntidao([dep('postgres', 'falha')]);
    expect(r.dependencias).toEqual([{ nome: 'postgres', estado: 'falha' }]);
    expect(Object.keys(r.dependencias[0])).toEqual(['nome', 'estado']);
  });
});

describe('a prontidão tem prazo', () => {
  /**
   * ─── O DEFEITO QUE ISTO PEGA, E COMO ELE APARECEU ─────────────────────────
   *
   * Medido em 29/09/2026, subindo a API com Postgres e Toddle inalcançáveis: a
   * checagem levou 26 SEGUNDOS. A causa é legítima — o `toddleClient` tem
   * escada de retry com backoff, que é o certo para um sync.
   *
   * Para uma sonda é o errado, e de um jeito que se volta contra o propósito
   * da rota: monitor externo tem timeout de 5 a 10s, então ele veria TIMEOUT em
   * vez do 503 que diz QUAL dependência caiu. "Não respondeu" manda investigar
   * a rede até a API; "respondeu 503: postgres" manda olhar o banco.
   *
   * Não teria aparecido em teste nenhum — só rodando. Fica travado aqui.
   */
  const nunca = (): Promise<DependenciaAvaliada> => new Promise(() => {});

  it('checagem que não responde no prazo conta como FORA', async () => {
    const r = await comPrazo('toddle', nunca, 20);
    expect(r).toEqual({ nome: 'toddle', estado: 'falha' });
  });

  it('e o prazo é respeitado de verdade — não espera a checagem', async () => {
    const comecou = Date.now();
    await comPrazo('toddle', nunca, 20);
    expect(Date.now() - comecou).toBeLessThan(1_000);
  });

  it('checagem rápida passa intacta, inclusive quando é limitado', async () => {
    const r = await comPrazo('toddle', async () => dep('toddle', 'limitado'), 500);
    expect(r.estado).toBe('limitado');
  });

  it('checagem rápida e ok passa intacta', async () => {
    const r = await comPrazo('postgres', async () => dep('postgres', 'ok'), 500);
    expect(r.estado).toBe('ok');
  });

  /**
   * `checarDependencia` já não lança hoje. Mas prontidão não é o lugar de
   * descobrir que alguém mudou isso: uma exceção vazando daqui derrubaria a
   * rota inteira com 500, e um 500 numa sonda de prontidão é indistinguível de
   * "a API morreu" — o diagnóstico errado, outra vez.
   */
  it('exceção na checagem vira FORA, não derruba a rota', async () => {
    const r = await comPrazo(
      'postgres',
      async () => {
        throw new Error('algo mudou lá embaixo');
      },
      500,
    );
    expect(r).toEqual({ nome: 'postgres', estado: 'falha' });
  });

  it('o prazo padrão é curto o bastante para um monitor esperar', () => {
    // Monitores costumam abortar entre 5s e 10s. O prazo tem de caber nisso
    // com folga para as duas checagens somadas.
    expect(PRAZO_DA_CHECAGEM_MS).toBeLessThanOrEqual(5_000);
  });
});

describe('assunto do alerta, por dependência', () => {
  /**
   * O assunto é a CHAVE da supressão. Esta regra já custou caro uma vez neste
   * projeto: o vigia montava `há ${idadeHoras.toFixed(1)}h` no assunto, o
   * número mudava a cada 6 minutos, e a supressão nunca acontecia.
   *
   * A primeira versão deste item repetiu o erro numa forma mais sutil: o
   * assunto carregava o CONJUNTO de dependências fora. Ordenado, portanto
   * estável para o mesmo conjunto — e ainda assim errado, porque o conjunto
   * varia. Com N dependências são 2^N−1 chaves, e um Toddle intermitente
   * enquanto o Postgres está fora DOBRA as notificações.
   */
  it('é estável para a mesma dependência', () => {
    expect(assuntoDeDependenciaFora('postgres')).toBe(assuntoDeDependenciaFora('postgres'));
  });

  it('não depende do que mais está fora ao lado', () => {
    // O ponto inteiro: o assunto de `postgres` é o mesmo esteja o Toddle no ar
    // ou não, porque ele não fala do Toddle.
    expect(assuntoDeDependenciaFora('postgres')).not.toContain('toddle');
  });

  it('dependências diferentes têm assuntos diferentes', () => {
    expect(assuntoDeDependenciaFora('postgres')).not.toBe(assuntoDeDependenciaFora('toddle'));
  });

  it('cair e voltar são assuntos diferentes — janelas independentes', () => {
    expect(assuntoDeDependenciaFora('postgres')).not.toBe(assuntoDeDependenciaVoltou('postgres'));
  });

  it('nomeia a dependência, para quem lê a notificação saber onde olhar', () => {
    expect(assuntoDeDependenciaFora('postgres')).toContain('postgres');
    expect(assuntoDeDependenciaVoltou('postgres')).toContain('postgres');
  });
});

describe('transições — o incidente tem começo e fim', () => {
  /**
   * ─── O QUE FALTAVA, E OS DOIS CONSELHEIROS APONTARAM JUNTO ────────────────
   *
   * Não havia aviso de RECUPERAÇÃO. O operador é acordado às 02:00, abre o
   * laptop às 02:05 e encontra tudo verde — sem saber se consertou sozinho, se
   * vai voltar, ou se o alerta era falso. Incidente sem fechamento é incidente
   * que ninguém aprende a confiar, e canal em que não se confia é canal
   * silenciado: exatamente a falha que este bloco de trabalho existe para
   * evitar.
   */
  const mapa = (e: Record<string, 'fora' | 'ok'>): Map<string, 'fora' | 'ok'> =>
    new Map(Object.entries(e));

  it('primeira observação já FORA conta como transição', () => {
    // O processo pode ter subido com o banco caído. Não avisar aqui seria
    // perder justamente o incidente que começou antes de nós.
    expect(transicoes(mapa({}), [dep('postgres', 'falha')])).toEqual([
      { nome: 'postgres', para: 'fora' },
    ]);
  });

  it('primeira observação OK não gera nada — não há incidente a relatar', () => {
    expect(transicoes(mapa({}), [dep('postgres', 'ok')])).toEqual([]);
  });

  it('continuar fora NÃO é transição: a supressão não é a única guarda', () => {
    expect(transicoes(mapa({ postgres: 'fora' }), [dep('postgres', 'falha')])).toEqual([]);
  });

  it('continuar ok não gera nada', () => {
    expect(transicoes(mapa({ postgres: 'ok' }), [dep('postgres', 'ok')])).toEqual([]);
  });

  it('voltar gera a transição de recuperação', () => {
    expect(transicoes(mapa({ postgres: 'fora' }), [dep('postgres', 'ok')])).toEqual([
      { nome: 'postgres', para: 'voltou' },
    ]);
  });

  it('só a que MUDOU vira transição, não as vizinhas', () => {
    const r = transicoes(mapa({ postgres: 'fora', toddle: 'ok' }), [
      dep('postgres', 'falha'),
      dep('toddle', 'falha'),
    ]);
    expect(r).toEqual([{ nome: 'toddle', para: 'fora' }]);
  });

  /**
   * `limitado` conta como ok, pela mesma razão que não derruba o 503: rate
   * limit do Toddle não é queda, e não pode acordar ninguém.
   */
  it('ir de ok para LIMITADO não é queda', () => {
    expect(transicoes(mapa({ toddle: 'ok' }), [dep('toddle', 'limitado')])).toEqual([]);
  });

  it('ir de FORA para limitado conta como recuperação', () => {
    // Saiu do ECONNREFUSED e agora só está sendo barrado por cota: voltou a
    // responder, que é o que o aviso de recuperação afirma.
    expect(transicoes(mapa({ toddle: 'fora' }), [dep('toddle', 'limitado')])).toEqual([
      { nome: 'toddle', para: 'voltou' },
    ]);
  });

  it('oscilar produz um par por ciclo, não uma tempestade de um lado só', () => {
    const anterior = mapa({});
    const passos: Array<[DependenciaAvaliada['estado'], number]> = [
      ['falha', 1],
      ['falha', 0],
      ['ok', 1],
      ['ok', 0],
      ['falha', 1],
    ];
    for (const [estado, esperado] of passos) {
      const t = transicoes(anterior, [dep('postgres', estado)]);
      expect(t).toHaveLength(esperado);
      anterior.set('postgres', estado === 'falha' ? 'fora' : 'ok');
    }
  });
});
