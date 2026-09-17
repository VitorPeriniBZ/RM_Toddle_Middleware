import type { FastifyPluginAsync } from 'fastify';
import { logger, tenantConfig } from '@rm-toddle/config';
import { pgPool, registrarEvento } from '@rm-toddle/db';
import { FLUXOS_EM_ORDEM, getQueue } from '@rm-toddle/queues';
import {
  SENTENCAS_DO_TODDLE,
  conferir,
  restaurar,
  type CodigoDeSentenca,
  type ConferenciaDeSentenca,
  type RestauracaoDeSentenca,
} from '@rm-toddle/integrations';
import { atorDaRequisicao, exigirPapel } from '../autorizacao';

/**
 * AS SENTENÇAS DO RM: ver se estão lá, e recolocá-las quando não estão.
 *
 * ─── POR QUE ISTO É UMA TELA, E NÃO UM SCRIPT ───────────────────────────────
 *
 * Sentença mora em `GCONSSQL`, que é DADO. Toda cópia de base por cima do
 * ambiente apaga as seis — 13–15/08/2026 e de novo em 16/09/2026. Enquanto elas
 * não voltam, nenhum fluxo de leitura do RM existe, porque não há outra fonte.
 *
 * Nas duas vezes a recuperação foi manual e demorou dias, e o que custou os dias
 * não foi recadastrar (20 a 40 minutos): foi ninguém saber que tinham sumido.
 * Então esta tela tem duas funções, e a primeira é a mais importante — DIZER o
 * estado. O botão é a segunda.
 *
 * ─── AS FILAS PARAM ENQUANTO A CARGA ACONTECE ───────────────────────────────
 *
 * Restaurar leva alguns segundos e, no meio deles, existem Sentenças no RM que
 * ainda não foram conferidas. Um job que rode nessa janela lê uma fonte em
 * estado indefinido e escreve no Toddle a partir dela. Como o cron é
 * `0 3,9,12,16`, essa colisão não precisa de ninguém para acontecer.
 *
 * Então a rota PAUSA as filas antes e RETOMA depois, no `finally`. Pausa de fila
 * é estado no Redis e sobrevive a um crash desta API — por isso o `GET` devolve
 * `filasPausadas`, e a tela mostra em vermelho. Uma fila pausada esquecida é
 * exatamente o silêncio que este projeto coleciona: tudo verde, nada rodando.
 *
 * ─── NÃO EXISTE ROTA QUE APAGUE ─────────────────────────────────────────────
 *
 * `remover()` existe no pacote de integrações porque a sonda precisou dela, e
 * não é exposta aqui. Apagar uma Sentença por HTTP derrubaria todos os fluxos de
 * uma vez, e nenhum caso de uso pede isso.
 */

/** O que a tela precisa saber para decidir se clica. */
interface PainelDeSentencas {
  coligada: string;
  periodoLetivo: string | null;
  /**
   * `true` quando a checagem foi só a releitura. Ver `conferir(..., { executar })`
   * — a tela abre barata e o botão de conferir roda as três camadas.
   */
  apenasReleitura: boolean;
  itens: ConferenciaDeSentenca[];
  ausentes: number;
  divergentes: number;
  /** Filas que estão pausadas AGORA. Vazio é o normal. */
  filasPausadas: string[];
}

/**
 * Roda uma coisa de cada vez.
 *
 * O RM é a mesma instalação para todas as seis, e disparar seis consultas
 * simultâneas (uma delas com ~7 mil linhas) contra ele foi o que derrubou a
 * janela de resposta em outros pontos deste projeto. Serial é rápido o
 * suficiente e não compete consigo mesmo.
 */
async function emSerie<T, R>(itens: readonly T[], f: (item: T) => Promise<R>): Promise<R[]> {
  const saida: R[] = [];
  for (const item of itens) saida.push(await f(item));
  return saida;
}

/** Nomes de fila do catálogo, sem repetir (dois fluxos podem dividir fila). */
function filasDosFluxos(): string[] {
  return [...new Set(FLUXOS_EM_ORDEM.map((f) => f.fila))];
}

async function filasPausadas(): Promise<string[]> {
  const pausadas: string[] = [];
  for (const nome of filasDosFluxos()) {
    try {
      if (await getQueue(nome).isPaused()) pausadas.push(nome);
    } catch (e) {
      // Redis fora do ar não pode derrubar a tela que diz o estado do RM — mas
      // também não pode virar "nenhuma pausada", que é uma afirmação que não
      // temos como fazer. Fica no log, e a tela não mente por omissão porque o
      // erro de Redis já aparece na aba Jobs.
      logger.warn({ fila: nome, err: (e as Error).message }, 'não deu para ler o estado da fila');
    }
  }
  return pausadas;
}

export const registrarRotasDeSentencas: FastifyPluginAsync = async (app) => {
  /**
   * O estado das seis — releitura só, para a tela abrir rápido.
   *
   * `viewer` porque é leitura, e porque "as Sentenças sumiram" é a informação
   * que mais gente precisa ver cedo. Quem não pode restaurar continua não
   * podendo: o POST exige outro papel.
   */
  app.get('/sentencas', { preHandler: exigirPapel(['viewer']) }, async () => {
    const itens = await emSerie(SENTENCAS_DO_TODDLE, (c) =>
      conferir(c, tenantConfig, { executar: false }),
    );
    const corpo: PainelDeSentencas = {
      coligada: String(tenantConfig.rm.escopo.coligada),
      periodoLetivo: tenantConfig.rm.escopo.periodoLetivo ?? null,
      apenasReleitura: true,
      itens,
      ausentes: itens.filter((i) => !i.existeNoRm).length,
      divergentes: itens.filter((i) => i.existeNoRm && !i.releitura.ok).length,
      filasPausadas: await filasPausadas(),
    };
    return corpo;
  });

  /**
   * SMOKE TEST: as três camadas, sem gravar nada.
   *
   * É o passo 2 do runbook do README — o que faltava nas duas perdas, e o que
   * teria transformado "dias" em "vinte minutos". Executa as seis de verdade
   * contra o RM, então é `integration_operator`: não muda nada, mas pesa.
   */
  app.post('/sentencas/conferir', { preHandler: exigirPapel(['integration_operator']) }, async () => {
    const itens = await emSerie(SENTENCAS_DO_TODDLE, (c) => conferir(c, tenantConfig));
    const corpo: PainelDeSentencas = {
      coligada: String(tenantConfig.rm.escopo.coligada),
      periodoLetivo: tenantConfig.rm.escopo.periodoLetivo ?? null,
      apenasReleitura: false,
      itens,
      ausentes: itens.filter((i) => !i.existeNoRm).length,
      divergentes: itens.filter((i) => i.existeNoRm && !i.releitura.ok).length,
      filasPausadas: await filasPausadas(),
    };
    return corpo;
  });

  /**
   * A CARGA: grava no RM o que falta e prova que voltou.
   *
   * `tenant_admin` porque escreve no RM. É o mesmo papel que muda agenda, e pela
   * mesma razão: não é operação de rotina.
   *
   * ─── O QUE TORNA SEGURO CLICAR DUAS VEZES ─────────────────────────────────
   *
   * `restaurar()` confere ANTES de enviar e não envia o que já está conferindo.
   * A idempotência é por estado observado, não por flag guardada — flag guardada
   * é o que mente depois de uma cópia de base.
   *
   * ─── A RESPOSTA NÃO DIZ "PRONTO" ──────────────────────────────────────────
   *
   * Devolve, por Sentença, o que cada camada achou. `restauradas` conta só as
   * que passaram nas três. Se o RM aceitar e a Sentença não executar, isto
   * aparece como falha nomeada — que é o oposto do `ok=true` que descartou uma
   * nota inteira em outra parte deste sistema.
   */
  app.post<{ Body: { codigos?: string[]; motivo?: string } }>(
    '/sentencas/restaurar',
    { preHandler: exigirPapel(['tenant_admin']) },
    async (req, reply) => {
      const pedidos = req.body?.codigos;
      const alvo: CodigoDeSentenca[] = pedidos?.length
        ? (pedidos.filter((c): c is CodigoDeSentenca =>
            (SENTENCAS_DO_TODDLE as readonly string[]).includes(c),
          ) as CodigoDeSentenca[])
        : [...SENTENCAS_DO_TODDLE];

      if (pedidos?.length && alvo.length !== pedidos.length) {
        return reply.code(400).send({
          erro: 'código de Sentença desconhecido',
          aceitos: SENTENCAS_DO_TODDLE,
        });
      }

      const filas = filasDosFluxos();
      const pausadasPorNos: string[] = [];
      let resultados: RestauracaoDeSentenca[] = [];

      try {
        // Só pausa o que estava rodando, e só retoma o que ESTE pedido pausou —
        // senão um clique aqui religaria uma fila que alguém tinha parado de
        // propósito.
        for (const nome of filas) {
          const fila = getQueue(nome);
          if (!(await fila.isPaused())) {
            await fila.pause();
            pausadasPorNos.push(nome);
          }
        }
        logger.info({ pausadas: pausadasPorNos, alvo }, 'restauração de Sentenças: filas pausadas');

        resultados = await emSerie(alvo, (c) => restaurar(c, tenantConfig));
      } finally {
        for (const nome of pausadasPorNos) {
          try {
            await getQueue(nome).resume();
          } catch (e) {
            // Falhar aqui deixa a fila parada, e uma fila parada não dá erro
            // nenhum: ela simplesmente não processa mais nada. Por isso é
            // `error` e não `warn`, e por isso o GET devolve `filasPausadas`.
            logger.error(
              { fila: nome, err: (e as Error).message },
              'NÃO retomei a fila depois da restauração — ela está PARADA',
            );
          }
        }
      }

      const restauradas = resultados.filter((r) => r.confere);
      const falhas = resultados.filter((r) => !r.confere);

      await registrarEvento(pgPool, {
        ator: atorDaRequisicao(req),
        acao: 'sentencas.restauradas',
        entidade: 'GCONSSQL',
        entidadeId: String(tenantConfig.rm.escopo.coligada),
        depois: resultados.map((r) => ({
          codigo: r.codigo,
          gravou: r.gravou,
          confere: r.confere,
          reprovouEm: r.reprovouEm,
          linhas: r.volume.linhas,
        })),
        motivo: req.body?.motivo,
        resultado: falhas.length === 0 ? 'succeeded' : 'failed',
      });

      return {
        pedidas: alvo.length,
        restauradas: restauradas.length,
        gravadas: resultados.filter((r) => r.gravou).length,
        falharam: falhas.length,
        filasPausadasDurante: pausadasPorNos,
        filasPausadasAgora: await filasPausadas(),
        itens: resultados,
        /**
         * O de-para de COURSE usa `IDTURMADISC`, que é identity e a cópia de
         * base RENUMERA. Restaurar as Sentenças não conserta isso, e o desfecho
         * ruim é silencioso: o número antigo passa a pertencer a outra
         * turma-disciplina e a nota vai para a turma errada. A tela repete este
         * aviso; a API o devolve para que ele exista também para quem chamar
         * por `curl`.
         */
        aindaFalta:
          falhas.length === 0
            ? 'Confira o de-para de COURSE antes de religar os jobs: IDTURMADISC é renumerado pela cópia de base ' +
              '(docs/rm-sentencas/de-para-idturmadisc-20260911.csv).'
            : null,
      };
    },
  );
};
