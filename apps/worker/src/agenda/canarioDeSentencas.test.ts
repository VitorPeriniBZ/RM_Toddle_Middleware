import { describe, expect, it } from 'vitest';
import type { ConferenciaDeSentenca } from '@rm-toddle/integrations';
import {
  achadoDe,
  assuntoDeSentenca,
  assuntoDeSentencaVoltou,
  transicoesDeSentenca,
  type AchadoDeSentenca,
  type EstadoDaSentenca,
} from './canarioDeSentencas';

/**
 * O CANÁRIO NÃO PODE VIRAR A PRÓXIMA FONTE DE RUÍDO.
 *
 * `conferir()` já existia e é boa. O que este módulo acrescenta é agendamento e
 * alerta — e as duas coisas têm um jeito clássico de dar errado: alertar sobre
 * o que não é problema, até alguém silenciar o canal. Como o canal é o mesmo
 * que carrega a DLQ e o vigia, silenciá-lo custaria tudo o que o P0-2 construiu.
 *
 * É isso que estes testes protegem, mais que a detecção em si.
 */

/** Uma conferência limpa. Cada teste altera só o campo que lhe interessa. */
const conferencia = (m: Partial<ConferenciaDeSentenca> = {}): ConferenciaDeSentenca => ({
  codigo: 'TODDLE.FREQ',
  existeNoRm: true,
  confere: true,
  verificacaoCompleta: true,
  releitura: { ok: true, detalhe: 'idêntica ao .sql' },
  execucao: { ok: true, detalhe: 'executou', colunasAusentes: [] },
  volume: { ok: true, linhas: 2449, detalhe: 'dentro do esperado' },
  reprovouEm: null,
  aviso: null,
  ...m,
});

describe('a armadilha da passada barata', () => {
  /**
   * ─── O DEFEITO QUE ISTO PEGA ──────────────────────────────────────────────
   *
   * `ConferenciaDeSentenca.confere` é `true` só quando as TRÊS camadas passam.
   * Com `executar: false`, a camada de execução devolve `ok: false` com detalhe
   * "não executada" — de propósito, porque "não verifiquei" não pode virar
   * "está bom".
   *
   * Consequência para quem lê o campo errado: `confere` é SEMPRE `false` na
   * passada barata. Um canário que alertasse por `!confere` mandaria SEIS
   * notificações por hora, para sempre, sobre Sentenças perfeitas.
   *
   * E o canal é o mesmo da DLQ e do vigia. Silenciado no primeiro dia, levaria
   * junto todo o P0-2.
   */
  const passadaBarata = conferencia({
    confere: false,
    verificacaoCompleta: false,
    execucao: { ok: false, detalhe: 'não executada — só a releitura foi pedida', colunasAusentes: [] },
    volume: { ok: false, linhas: null, detalhe: 'não contado' },
  });

  it('Sentença perfeita numa passada barata NÃO gera achado', () => {
    expect(
      achadoDe(passadaBarata),
      'o canário está lendo `confere`, que é sempre false quando a execução não roda. ' +
        'Isso são 6 notificações por hora sobre Sentenças boas, e o canal silenciado no ' +
        'primeiro dia — levando junto a DLQ e o vigia, que usam o mesmo canal.',
    ).toBeNull();
  });

  it('mas o corpo divergente na passada barata GERA achado', () => {
    const r = achadoDe(
      conferencia({
        ...passadaBarata,
        releitura: { ok: false, detalhe: 'corpo difere do .sql' },
      }),
    );
    expect(r?.estado).toBe('divergente');
    expect(r?.camada).toBe('releitura');
  });

  it('e a Sentença ausente na passada barata GERA achado', () => {
    const r = achadoDe(
      conferencia({ ...passadaBarata, existeNoRm: false, releitura: { ok: false, detalhe: 'não existe no RM' } }),
    );
    expect(r?.estado).toBe('ausente');
  });
});

describe('leitura das camadas na verificação completa', () => {
  it('tudo ok: sem achado', () => {
    expect(achadoDe(conferencia())).toBeNull();
  });

  it('execução reprovada vira achado, com as colunas ausentes', () => {
    const r = achadoDe(
      conferencia({
        confere: false,
        execucao: {
          ok: false,
          detalhe: 'faltaram colunas no result set',
          colunasAusentes: ['ID_TURMADISC', 'ID_HORARIO_TURMA'],
        },
      }),
    );
    expect(r?.camada).toBe('execucao');
    expect(r?.colunasAusentes).toEqual(['ID_TURMADISC', 'ID_HORARIO_TURMA']);
  });

  it('volume reprovado vira achado', () => {
    const r = achadoDe(
      conferencia({ confere: false, volume: { ok: false, linhas: 3, detalhe: 'muito abaixo' } }),
    );
    expect(r?.camada).toBe('volume');
  });

  /**
   * A ordem importa: uma Sentença ausente também reprova execução e volume, e
   * relatar "volume fora do esperado" sobre algo que nem existe manda quem lê
   * olhar o lugar errado.
   */
  it('ausente é relatada como ausente, não como volume', () => {
    const r = achadoDe(
      conferencia({
        existeNoRm: false,
        confere: false,
        releitura: { ok: false, detalhe: 'não existe no RM' },
        execucao: { ok: false, detalhe: 'não executada', colunasAusentes: [] },
        volume: { ok: false, linhas: null, detalhe: 'não contado' },
      }),
    );
    expect(r?.estado).toBe('ausente');
    expect(r?.camada).toBe('releitura');
  });
});

describe('assunto estável — contrato do P0-2', () => {
  /**
   * O assunto é a CHAVE da supressão. Este projeto já errou isto duas vezes:
   * o vigia com `há 13.2h` no assunto, e o P0-3 com o CONJUNTO de dependências.
   * Nada mutável entra aqui.
   */
  it('é estável para a mesma Sentença e camada', () => {
    expect(assuntoDeSentenca('TODDLE.FREQ', 'execucao')).toBe(
      assuntoDeSentenca('TODDLE.FREQ', 'execucao'),
    );
  });

  it('camadas diferentes são incidentes diferentes, com janelas independentes', () => {
    expect(assuntoDeSentenca('TODDLE.FREQ', 'releitura')).not.toBe(
      assuntoDeSentenca('TODDLE.FREQ', 'execucao'),
    );
  });

  it('Sentenças diferentes são assuntos diferentes', () => {
    expect(assuntoDeSentenca('TODDLE.FREQ', 'execucao')).not.toBe(
      assuntoDeSentenca('TODDLE.NOTAS', 'execucao'),
    );
  });

  it('cair e voltar são assuntos diferentes', () => {
    expect(assuntoDeSentenca('TODDLE.FREQ', 'releitura')).not.toBe(
      assuntoDeSentencaVoltou('TODDLE.FREQ'),
    );
  });

  it('NÃO carrega colunas ausentes nem detalhe — eles mudam', () => {
    const a = assuntoDeSentenca('TODDLE.FREQ', 'execucao');
    expect(a).not.toContain('ID_TURMADISC');
    expect(a).not.toMatch(/\d/); // nenhum número: contagem é dado mutável
  });
});

describe('transições — incidente com começo e fim', () => {
  const mapa = (e: Record<string, EstadoDaSentenca>): Map<string, EstadoDaSentenca> =>
    new Map(Object.entries(e));
  const achado = (codigo: string, estado: EstadoDaSentenca = 'divergente'): AchadoDeSentenca => ({
    codigo: codigo as AchadoDeSentenca['codigo'],
    estado,
    camada: 'releitura',
    detalhe: 'corpo difere',
    colunasAusentes: [],
  });

  it('primeira observação já divergente conta como transição', () => {
    const t = transicoesDeSentenca(mapa({}), [achado('TODDLE.FREQ')], ['TODDLE.FREQ']);
    expect(t).toEqual([
      { codigo: 'TODDLE.FREQ', para: 'achado', achado: achado('TODDLE.FREQ') },
    ]);
  });

  it('primeira observação ok não gera nada', () => {
    expect(transicoesDeSentenca(mapa({}), [], ['TODDLE.FREQ'])).toEqual([]);
  });

  it('continuar divergente NÃO é transição', () => {
    expect(
      transicoesDeSentenca(mapa({ 'TODDLE.FREQ': 'divergente' }), [achado('TODDLE.FREQ')], [
        'TODDLE.FREQ',
      ]),
    ).toEqual([]);
  });

  it('o restauro reativo conserta e o canário fecha o incidente', () => {
    const t = transicoesDeSentenca(mapa({ 'TODDLE.FREQ': 'ausente' }), [], ['TODDLE.FREQ']);
    expect(t).toEqual([{ codigo: 'TODDLE.FREQ', para: 'voltou', achado: null }]);
  });

  it('mudar de ausente para divergente é transição nova', () => {
    // Restaurou, mas com a versão errada: é outro incidente, e quem lê precisa
    // saber que o estado mudou em vez de achar que continua tudo igual.
    const t = transicoesDeSentenca(
      mapa({ 'TODDLE.FREQ': 'ausente' }),
      [achado('TODDLE.FREQ', 'divergente')],
      ['TODDLE.FREQ'],
    );
    expect(t).toHaveLength(1);
    expect(t[0].para).toBe('achado');
  });

  /**
   * ─── O DEFEITO QUE ESTE BLOCO EXISTE PARA IMPEDIR ─────────────────────────
   *
   * Se a rede cair na terceira das seis conferências, as outras três não foram
   * avaliadas. Sem o recorte por `avaliadas`, a memória delas seria apagada e a
   * passada seguinte emitiria "voltou a conferir" sobre Sentenças que ninguém
   * verificou — um fechamento de incidente FALSO.
   *
   * Fechamento falso é pior que nenhum: ele diz ao operador que pode parar de
   * se preocupar.
   */
  it('Sentença NÃO avaliada não muda de estado', () => {
    const t = transicoesDeSentenca(mapa({ 'TODDLE.NOTAS': 'divergente' }), [], ['TODDLE.FREQ']);
    expect(
      t,
      'a TODDLE.NOTAS não foi avaliada nesta passada, e ainda assim o canário anunciou que ' +
        'ela voltou. Fechar um incidente que ninguém verificou é pior que não fechar.',
    ).toEqual([]);
  });

  it('só as avaliadas entram, mesmo com achados de outras', () => {
    const t = transicoesDeSentenca(
      mapa({}),
      [achado('TODDLE.FREQ'), achado('TODDLE.NOTAS')],
      ['TODDLE.FREQ'],
    );
    expect(t.map((x) => x.codigo)).toEqual(['TODDLE.FREQ']);
  });

  it('um ciclo completo: divergiu, alertou, voltou, fechou', () => {
    const memoria = mapa({});
    const passos: Array<[AchadoDeSentenca[], number, string | null]> = [
      [[achado('TODDLE.FREQ')], 1, 'achado'],
      [[achado('TODDLE.FREQ')], 0, null],
      [[], 1, 'voltou'],
      [[], 0, null],
    ];
    for (const [achados, quantos, para] of passos) {
      const t = transicoesDeSentenca(memoria, achados, ['TODDLE.FREQ']);
      expect(t).toHaveLength(quantos);
      if (para) expect(t[0].para).toBe(para);
      memoria.set('TODDLE.FREQ', achados[0]?.estado ?? 'ok');
    }
  });
});
