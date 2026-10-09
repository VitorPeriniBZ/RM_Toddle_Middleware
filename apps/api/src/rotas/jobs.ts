import type { FastifyPluginAsync } from 'fastify';
import { historicoDeRuns, type RunNoHistorico } from '@rm-toddle/db';
import {
  ESTADOS_NAO_TERMINAIS,
  FLUXOS_EM_ORDEM,
  execucoesEmVoo,
  getQueue,
  lerProgresso,
  PREFIXO_DO_DISPARO_CONTINUO,
  resumoDaDlq,
  type ProgressoDeJob,
} from '@rm-toddle/queues';
import { exigirPapel } from '../autorizacao';

/**
 * O PAINEL DE JOBS: o que está rodando agora e o que rodou antes.
 *
 * ─── TUDO AQUI É MEDIDO; NADA É ESTIMADO ────────────────────────────────────
 *
 * Três fontes, e cada número diz de qual veio:
 *
 *   1. **BullMQ (Redis)** — contagens por fila, job ativo com seu
 *      `job.progress`, e o histórico curto de terminados. A retenção é a do
 *      `defaultJobOptions`: concluído por 24h (até 5.000), falho por 7 dias.
 *      Depois disso o job some do Redis, e some daqui.
 *   2. **`job_run` (Postgres)** — o histórico durável, uma linha por execução.
 *      É de onde sai a duração e o desfecho de runs mais antigos que a retenção
 *      do Redis, e o progresso do fan-out de aluno.
 *   3. **DLQ** — o que morreu de vez.
 *
 * ─── POR QUE O PROGRESSO DE ALUNO VEM DE OUTRO LUGAR ────────────────────────
 *
 * O sync de aluno é fan-out: o job de extract termina depois de ENFILEIRAR os
 * lotes, e quem trabalha são os lotes, que são jobs irmãos. O `job.progress` do
 * extract, portanto, fica em 100% enquanto o trabalho de verdade mal começou.
 *
 * O progresso verdadeiro do run está no Postgres desde antes deste arquivo:
 * `lotesEsperados` no payload e `lotesConcluidos` no resultado, incrementado
 * atomicamente por cada lote. É de lá que sai a barra — e é por isso que ela é
 * real, e não uma animação.
 *
 * ─── O HISTÓRICO COMEÇA CURTO, E ISSO NÃO É DEFEITO ─────────────────────────
 *
 * `job_run` acumula daqui para frente; não existe retroativamente. A resposta
 * carrega `historicoSuficiente` para a tela poder dizer "ainda acumulando" em
 * vez de desenhar um gráfico de um ponto só, que parece quebrado.
 */

interface JobAtivo {
  id: string | null;
  nome: string;
  /** `null` quando o job ainda não publicou fase alguma. */
  progresso: ProgressoDeJob | null;
  iniciadoEm: string | null;
  tentativa: number;
}

/**
 * Um job que já terminou, como o Redis o guarda.
 *
 * Existe porque `job_run` NÃO cobre tudo: um job que roda e decide não fazer
 * nada — a via de nota com `NOTA_SYNC_ATIVO=false` é o caso — retorna antes de
 * abrir run, e ficava invisível. A tela dizia "último sucesso: nunca" com o job
 * tendo rodado trinta segundos antes, o que é a tela mentindo.
 *
 * Aqui o retorno do job viaja junto: é ele que diz `{"desligado":true}`.
 */
interface JobTerminado {
  id: string | null;
  nome: string;
  desfecho: 'completed' | 'failed';
  terminadoEm: string | null;
  duracaoMs: number | null;
  tentativas: number;
  /** O que o processador devolveu. É onde aparece `desligado: true`. */
  retorno: unknown;
  erro: string | null;
  /** `true` quando veio do botão "Sincronizar agora". */
  manual: boolean;
  /**
   * De onde veio o disparo. `manual` continua existindo por compatibilidade;
   * `origem` é o que a tela usa, porque agora são três: o botão, a agenda e
   * um detector de mudança ("tempo quase real").
   */
  origem: 'manual' | 'continuo' | 'agenda';
}

/**
 * `preso` é um quarto desfecho, e existe porque `executing` mente com o tempo.
 *
 * Um run só fecha quando o último lote reporta. Se um lote morre — 429 do
 * Toddle, worker derrubado no meio — ninguém fecha, e a linha fica `executing`
 * para sempre. O banco tem quatro runs assim desde agosto, provando que
 * acontece.
 *
 * Sem distinguir, o painel desenhava "83% em curso" indefinidamente, com a
 * barra crescendo a cada recarga. Isso é a tela mentindo, que é exatamente o
 * que ela existe para não fazer.
 *
 * O sinal não é "começou há muito tempo" — é `updated_at` parado. Cada lote que
 * termina move essa coluna (`acumularLote`); se ela não anda, ninguém está
 * trabalhando.
 */
const MINUTOS_SEM_NOTICIA_PARA_PRESO = 15;

interface RunNoGrafico {
  chave: string;
  desfecho: 'succeeded' | 'failed' | 'executing' | 'preso';
  inicioEm: string;
  /** `null` quando não há duração de execução — ver `RunNoHistorico.duracaoMs`. */
  duracaoMs: number | null;
  /** `lotesConcluidos/lotesEsperados`, quando o fluxo é fan-out. */
  lotes?: { feitos: number; total: number };
  /** Só em `preso`: há quanto tempo nenhum lote reporta. */
  semNoticiaHaMs?: number;
}

/** O prefixo do id diz quem pediu: ver `api/rotas/agenda.ts` e `queues/detectores.ts`. */
function origemDoJob(id: string): JobTerminado['origem'] {
  if (id.startsWith('manual:')) return 'manual';
  if (id.startsWith(PREFIXO_DO_DISPARO_CONTINUO)) return 'continuo';
  return 'agenda';
}

/** O mínimo de runs para um gráfico dizer alguma coisa sobre tendência. */
const MINIMO_PARA_GRAFICO = 5;

export const registrarRotasDeJobs: FastifyPluginAsync = async (app) => {
  app.get('/jobs', { preHandler: exigirPapel(['viewer']) }, async () => {
    const tipos = FLUXOS_EM_ORDEM.map((f) => f.key);
    const historico = await historicoDeRuns(tipos, 40);

    const fluxos = await Promise.all(
      FLUXOS_EM_ORDEM.map(async (fluxo) => {
        const fila = getQueue(fluxo.fila);

        // ─── o que está na fila agora ────────────────────────────────────
        //
        // O marcador do próximo cron é `delayed` permanente e NÃO é trabalho —
        // a mesma regra do botão "Sincronizar agora". Contá-lo aqui faria o
        // painel dizer "1 esperando" 24h por dia. Ver `execucaoEmVoo`.
        const naFila = await fila.getJobs([...ESTADOS_NAO_TERMINAIS]);
        const comEstado = await Promise.all(
          naFila.map(async (j) => ({
            job: j,
            estado: (await j.getState()) as 'waiting' | 'active' | 'delayed' | 'paused' | 'prioritized',
            repeatJobKey: (j as { repeatJobKey?: string | null }).repeatJobKey ?? null,
          })),
        );
        const emVoo = comEstado.filter(
          (x) => execucoesEmVoo([{ estado: x.estado, repeatJobKey: x.repeatJobKey }]).length > 0,
        );

        const ativos: JobAtivo[] = emVoo
          .filter((x) => x.estado === 'active')
          .map((x) => ({
            id: x.job.id ?? null,
            nome: x.job.name,
            progresso: lerProgresso(x.job.progress),
            iniciadoEm: x.job.processedOn ? new Date(x.job.processedOn).toISOString() : null,
            tentativa: x.job.attemptsMade + 1,
          }));

        // ─── o que acabou de terminar ────────────────────────────────────
        //
        // Retenção do `defaultJobOptions`: concluído por 24h, falho por 7 dias.
        // É a janela curta; o histórico durável continua sendo `job_run`.
        const terminadosBrutos = [
          ...(await fila.getJobs(['completed'], 0, 9)),
          ...(await fila.getJobs(['failed'], 0, 9)),
        ];
        const terminados: JobTerminado[] = terminadosBrutos
          .map((j) => ({
            id: j.id ?? null,
            nome: j.name,
            desfecho: (j.failedReason ? 'failed' : 'completed') as 'completed' | 'failed',
            terminadoEm: j.finishedOn ? new Date(j.finishedOn).toISOString() : null,
            duracaoMs: j.finishedOn && j.processedOn ? j.finishedOn - j.processedOn : null,
            tentativas: j.attemptsMade,
            retorno: j.returnvalue ?? null,
            erro: j.failedReason ?? null,
            manual: String(j.id ?? '').startsWith('manual:'),
            origem: origemDoJob(String(j.id ?? '')),
          }))
          .sort((a, b) => (b.terminadoEm ?? '').localeCompare(a.terminadoEm ?? ''))
          .slice(0, 10);

        const contagem = {
          ativos: ativos.length,
          esperando: emVoo.filter((x) => x.estado !== 'active').length,
          /** O marcador do cron, separado: é reserva de horário, não trabalho. */
          reservaDeCron: comEstado.length - emVoo.length,
        };

        // ─── o histórico durável ─────────────────────────────────────────
        const runs: RunNoHistorico[] = historico[fluxo.key] ?? [];
        const grafico: RunNoGrafico[] = runs.map((r) => {
          const total = Number(r.payload.lotesEsperados);
          const feitos = Number(r.resultado.lotesConcluidos);
          const paradoHaMs = Date.now() - new Date(r.atualizadoEm).getTime();
          const preso =
            r.estado === 'executing' && paradoHaMs > MINUTOS_SEM_NOTICIA_PARA_PRESO * 60_000;
          return {
            chave: r.chave,
            desfecho: preso ? 'preso' : (r.estado as RunNoGrafico['desfecho']),
            inicioEm: r.criadoEm,
            // Run aberto não tem duração final: o que se pode dizer é há quanto
            // tempo ele começou.
            duracaoMs:
              r.estado === 'executing' ? Date.now() - new Date(r.criadoEm).getTime() : r.duracaoMs,
            ...(preso ? { semNoticiaHaMs: paradoHaMs } : {}),
            ...(Number.isFinite(total) && total > 0
              ? { lotes: { feitos: Number.isFinite(feitos) ? feitos : 0, total } }
              : {}),
          };
        });

        // A barra de progresso é só para run que está REALMENTE andando. Um run
        // preso mostrando "83%" seria uma animação parada fingindo trabalho.
        const emCurso = grafico.find((g) => g.desfecho === 'executing');
        const presos = grafico.filter((g) => g.desfecho === 'preso');

        return {
          flowKey: fluxo.key,
          rotulo: fluxo.rotulo,
          fila: fluxo.fila,
          contagem,
          ativos,
          terminados,
          /** Progresso por LOTE, quando o fluxo é fan-out e há run em curso. */
          lotesEmCurso: emCurso?.lotes ?? null,
          /** Runs abertos que pararam de dar notícia. Precisam de decisão humana. */
          runsPresos: presos,
          historico: grafico,
          historicoSuficiente: grafico.length >= MINIMO_PARA_GRAFICO,
          minimoParaGrafico: MINIMO_PARA_GRAFICO,
        };
      }),
    );

    const dlq = await resumoDaDlq(5);

    return {
      fluxos,
      dlq,
      retencao: {
        // Escrito aqui para a tela poder explicar por que o histórico curto do
        // Redis some — em vez de a pessoa achar que o painel perdeu dado.
        concluidosNoRedisHoras: 24,
        falhosNoRedisDias: 7,
        duravelEm: 'job_run (Postgres), uma linha por execução, sem expiração',
      },
    };
  });
};
