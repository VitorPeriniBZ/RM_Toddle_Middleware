import {
  FLUXOS_EM_ORDEM,
  acharFluxo,
  aplicarAgenda,
  assinarAgenda,
  observarSchedulers,
  redisConnection,
  removerAgenda,
  removerSchedulerPorId,
  type Fluxo,
} from '@rm-toddle/queues';
import {
  comTravaDeReconciliacao,
  listarAgenda,
  marcarAplicada,
  semear,
  type AgendaDoFluxo,
} from '@rm-toddle/db';
import { TZ_AGENDA, cronDoProfessor, env, logger } from '@rm-toddle/config';

/**
 * RECONCILIAÇÃO DA AGENDA — o único caminho entre a intenção e o Redis.
 *
 * ─── O DESENHO EM UMA FRASE ─────────────────────────────────────────────────
 *
 * Postgres é a verdade (`flow_schedule`), Redis é projeção derivada, e esta
 * função é a única que traduz uma na outra. A API grava a intenção e avisa; ela
 * nunca toca o Redis.
 *
 * ─── TRÊS GATILHOS, E O PISO É O POLL ───────────────────────────────────────
 *
 *   1. `ready` do ioredis  — cobre boot e RECONEXÃO. Quando o Redis reinicia sem
 *      persistência, o scheduler desaparece e nada dá erro: o worker segue de pé
 *      consumindo uma fila que nunca mais recebe nada. O worker não reinicia
 *      nesse caso, ele reconecta — então registrar só no boot não cobriria
 *      justamente o cenário que motivou tudo isto.
 *   2. aviso por pub/sub  — é o que faz a tela responder em segundos.
 *   3. poll                — o PISO. Pub/sub é entrega no máximo uma vez; se o
 *      aviso se perder (worker reiniciando, Redis reiniciando), o poll converge
 *      sozinho. Ele existe para que nenhuma mudança fique pendente para sempre
 *      por causa de uma mensagem perdida.
 *
 * Se algum dia alguém remover o poll "porque o pub/sub já avisa", a falha
 * silenciosa volta.
 *
 * ─── DIFF NOS DOIS SENTIDOS ─────────────────────────────────────────────────
 *
 * Aplicar o que está ligado é metade. A outra metade é REMOVER o que não deveria
 * estar lá: fluxo desligado cujo scheduler continua no Redis, e scheduler órfão
 * com id que não pertence a fluxo nenhum. Só fazer upsert deixa registro
 * disparando para sempre, invisível em qualquer configuração.
 *
 * Esta troca de agenda PRODUZ órfãos uma vez, de propósito: os ids antigos eram
 * `students-sync-nightly`, `staff-sync-nightly` e `term-grades-poll`; os novos são
 * as chaves de fluxo (`students.sync`...). A primeira reconciliação depois do
 * deploy varre os três antigos. Sem essa varredura, o sync de aluno rodaria DUAS
 * vezes por noite — uma por cada id.
 */

/** Resultado de uma passada, para o log dizer o que de fato mudou. */
export interface ResultadoReconciliacao {
  aplicados: string[];
  removidos: string[];
  orfaosRemovidos: string[];
  inalterados: string[];
  erros: Array<{ flowKey: string; erro: string }>;
}

/**
 * Semeia a agenda a partir do ambiente — UMA VEZ por fluxo, na primeira subida.
 *
 * ─── A PRECEDÊNCIA É DE UMA VIA, E ISSO É O PONTO ───────────────────────────
 *
 * `semear()` usa `ON CONFLICT DO NOTHING`: o ambiente só vale quando não há
 * linha. Depois disso, mudar `STUDENTS_SYNC_CRON` no Coolify não muda nada — e é
 * exatamente o comportamento desejado, porque a alternativa ("env vence quando
 * presente") faria o próximo deploy desfazer em silêncio o que a tela mudou, com
 * a tela mostrando o valor novo por cima. Duas fontes de verdade, uma delas
 * mentindo.
 *
 * O cron do professor é DERIVADO aqui, e só aqui: `cronDoProfessor` some do
 * runtime e vira semente. Ver a explicação inteira em
 * packages/config/src/cronProfessor.ts.
 */
export async function semearDoAmbiente(): Promise<string[]> {
  const semeados: string[] = [];

  const semente = (fluxo: Fluxo): { cron: string; ativo: boolean } => {
    switch (fluxo.key) {
      case 'students.sync':
        return { cron: env.STUDENTS_SYNC_CRON, ativo: true };
      case 'staff.sync':
        return { cron: cronDoProfessor(env.STUDENTS_SYNC_CRON), ativo: true };
      case 'term-grades.sync':
        return { cron: env.NOTA_SYNC_CRON, ativo: env.NOTA_SYNC_ATIVO };
      // Nasce LIGADO, e é a única exceção ao fail-closed do default abaixo:
      // ele não escreve em lugar nenhum — compara o RM com o de-para e relata.
      // Deixá-lo desligado seria manter a deriva invisível, que é o problema
      // que ele existe para resolver.
      case 'courses.sync':
        return { cron: env.TURMAS_SYNC_CRON, ativo: true };
      // Nasce DESLIGADO salvo decisão explícita da escola: escreve em registro
      // acadêmico, e o TOTVS é a fonte de verdade da frequência.
      case 'attendance.sync':
        return { cron: env.FREQ_SYNC_CRON, ativo: env.FREQ_SYNC_ATIVO };
      default:
        // Fluxo novo no catálogo sem semente declarada nasce DESLIGADO, com um
        // cron plausível. Fail-closed: um fluxo que ninguém decidiu ligar não
        // pode começar ligado por omissão de quem o acrescentou.
        return { cron: '0 3 * * *', ativo: false };
    }
  };

  for (const fluxo of FLUXOS_EM_ORDEM) {
    const { cron, ativo } = semente(fluxo);

    // Ambiente pedindo para ligar um fluxo BLOQUEADO não é obedecido, e o aviso
    // é alto: ligar aqui não seria inócuo (o processador da nota recusa rodar e
    // cada disparo cairia na DLQ). Silenciar seria pior — alguém acharia que
    // ligou.
    const ativoEfetivo = ativo && fluxo.podeAtivar;
    if (ativo && !fluxo.podeAtivar) {
      logger.warn(
        { flowKey: fluxo.key, motivo: fluxo.motivoDoBloqueio },
        'O ambiente pede este fluxo LIGADO, mas ele está bloqueado no catálogo — semeado DESLIGADO',
      );
    }

    if (await semear(fluxo.key, cron, ativoEfetivo, TZ_AGENDA)) {
      semeados.push(fluxo.key);
      logger.info(
        { flowKey: fluxo.key, cron, ativo: ativoEfetivo },
        'Agenda SEMEADA a partir do ambiente — a partir de agora quem manda é o banco',
      );
    }
  }
  return semeados;
}

/** Precisa reescrever o scheduler no Redis? */
function precisaAplicar(
  desejado: AgendaDoFluxo,
  observado: { cron: string | null; tz: string | null } | undefined,
): string | null {
  if (!observado) return 'não existe no Redis';
  if (observado.cron !== desejado.cron) return `cron divergente (Redis: "${observado.cron}")`;
  if (observado.tz !== desejado.timezone) return `fuso divergente (Redis: "${observado.tz}")`;
  if (desejado.revisaoAplicada !== desejado.revisao) {
    return `revisão ${desejado.revisao} ainda não aplicada (aplicada: ${desejado.revisaoAplicada ?? 'nenhuma'})`;
  }
  return null;
}

/**
 * Uma passada de reconciliação. Serializada por advisory lock do Postgres.
 *
 * Devolve `'ocupado'` quando outra passada está em curso — e desistir é correto:
 * a que está rodando lê a mesma tabela e aplica a mesma revisão.
 */
export async function reconcileSchedulers(
  motivo: string,
): Promise<ResultadoReconciliacao | 'ocupado'> {
  return comTravaDeReconciliacao(async () => {
    const resultado: ResultadoReconciliacao = {
      aplicados: [], removidos: [], orfaosRemovidos: [], inalterados: [], erros: [],
    };

    const agenda = new Map((await listarAgenda()).map((a) => [a.flowKey, a]));
    const leitura = await observarSchedulers();
    const { observados } = leitura;
    const porId = new Map(observados.map((o) => [o.id, o]));
    const filasIlegiveis = new Set(leitura.ilegiveis.map((i) => i.fila));

    for (const fluxo of FLUXOS_EM_ORDEM) {
      const desejado = agenda.get(fluxo.key);
      const observado = porId.get(fluxo.key);

      // Fila ilegível: NÃO agir. Reconciliar é comparar desejado com observado,
      // e aqui o observado é desconhecido — não vazio. Aplicar às cegas faria o
      // reconciliador reescrever a agenda toda vez que o Redis piscasse, e
      // reportar "aplicado" sem nunca ter comparado com nada.
      if (filasIlegiveis.has(fluxo.fila)) {
        const erro = leitura.ilegiveis.find((i) => i.fila === fluxo.fila)?.erro ?? 'desconhecido';
        resultado.erros.push({ flowKey: fluxo.key, erro: `fila ilegível: ${erro}` });
        logger.warn(
          { flowKey: fluxo.key, fila: fluxo.fila, erro },
          'Reconciliação PULADA: não foi possível ler os schedulers desta fila, e agir sem ' +
            'saber o estado atual é pior que não agir',
        );
        continue;
      }

      // Linha ausente = DESLIGADO. Não é caso de erro nem de default: é a
      // propriedade de segurança que veio do `NOTA_SYNC_ATIVO` — escrita
      // automática em registro acadêmico não pode existir por omissão.
      const deveEstarLigado = Boolean(desejado?.ativo) && fluxo.podeAtivar;

      try {
        if (!deveEstarLigado) {
          if (observado) {
            await removerAgenda(fluxo);
            resultado.removidos.push(fluxo.key);
          } else {
            resultado.inalterados.push(fluxo.key);
          }
          // Marca aplicada mesmo no caso desligado: sem isto a tela mostraria
          // "revisão pendente" para sempre num fluxo que está exatamente como
          // pedido.
          if (desejado) await marcarAplicada(fluxo.key, desejado.revisao, null);
          continue;
        }

        const porque = precisaAplicar(desejado as AgendaDoFluxo, observado);
        if (!porque) {
          resultado.inalterados.push(fluxo.key);
          continue;
        }

        await aplicarAgenda(fluxo, (desejado as AgendaDoFluxo).cron, (desejado as AgendaDoFluxo).timezone);
        await marcarAplicada(fluxo.key, (desejado as AgendaDoFluxo).revisao, null);
        resultado.aplicados.push(fluxo.key);
        logger.info(
          { flowKey: fluxo.key, cron: (desejado as AgendaDoFluxo).cron, motivo, porque },
          'Scheduler aplicado',
        );
      } catch (err) {
        const erro = (err as Error).message;
        resultado.erros.push({ flowKey: fluxo.key, erro });
        if (desejado) await marcarAplicada(fluxo.key, desejado.revisaoAplicada ?? 0, erro);
        logger.error({ err, flowKey: fluxo.key, motivo }, 'Falha ao aplicar a agenda deste fluxo');
      }
    }

    // Órfãos: id no Redis que não é de fluxo nenhum. Ver o cabeçalho.
    for (const o of observados) {
      if (!o.desconhecido || acharFluxo(o.id)) continue;
      await removerSchedulerPorId(o.fila, o.id);
      resultado.orfaosRemovidos.push(o.id);
      logger.warn(
        { id: o.id, fila: o.fila, cron: o.cron },
        'Scheduler ÓRFÃO removido: id não corresponde a nenhum fluxo do catálogo — ele estava ' +
          'disparando sem aparecer em nenhuma configuração',
      );
    }

    if (resultado.aplicados.length || resultado.removidos.length || resultado.orfaosRemovidos.length) {
      logger.info({ motivo, ...resultado }, 'Agenda reconciliada');
    } else {
      logger.debug({ motivo, ...resultado }, 'Agenda já estava conforme');
    }
    return resultado;
  });
}

/**
 * Mantém a agenda conforme enquanto o worker estiver de pé.
 *
 * Devolve a função de encerramento: sem ela, o `setInterval` e a conexão de
 * assinatura seguiriam vivos depois do `worker.close()` e o processo não sairia
 * no SIGTERM — o encerramento gracioso viraria `kill -9` depois do
 * `stop_grace_period`.
 */
export function manterAgendamento(): () => Promise<void> {
  let emAndamento = false;

  const reconciliar = async (motivo: string): Promise<void> => {
    // O 'ready' pode disparar em rajada numa reconexão instável; sem esta guarda
    // as chamadas se sobreporiam. A trava no Postgres cobre o caso entre
    // PROCESSOS; esta cobre o caso dentro deste.
    if (emAndamento) return;
    emAndamento = true;
    try {
      await reconcileSchedulers(motivo);
    } catch (err) {
      // Falha aqui NÃO derruba o worker: consumir a fila é mais importante que
      // manter o agendamento, e o próximo poll tenta de novo. Mas o erro é
      // logado alto, porque agendamento ausente é invisível por natureza.
      logger.error(
        { err, motivo },
        'FALHA na reconciliação da agenda — o sync pode não disparar. Confira a tela ' +
          '(desejado × observado) ou `redis-cli zrange bull:rm-to-toddle.students:repeat 0 -1`',
      );
    } finally {
      emAndamento = false;
    }
  };

  // Se a conexão já estava pronta antes deste listener existir, o 'ready' dela
  // já passou e não voltaria — daí a chamada imediata.
  if (redisConnection.status === 'ready') void reconciliar('boot');
  redisConnection.on('ready', () => void reconciliar('redis-ready'));

  const assinante = assinarAgenda((flowKey) => void reconciliar(`aviso:${flowKey}`));
  const timer = setInterval(() => void reconciliar('poll'), env.AGENDA_RECONCILIA_MS);

  logger.info(
    { pollMs: env.AGENDA_RECONCILIA_MS, fluxos: FLUXOS_EM_ORDEM.map((f) => f.key) },
    'Reconciliação da agenda ativa (ready + aviso + poll)',
  );

  return async () => {
    clearInterval(timer);
    await assinante.quit().catch(() => undefined);
  };
}
