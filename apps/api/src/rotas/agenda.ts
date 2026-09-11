import type { FastifyPluginAsync } from 'fastify';
import { avaliarFolga, logger, proximosDisparos, validarCron } from '@rm-toddle/config';
import {
  alterarAgenda,
  listarAgenda,
  pgPool,
  registrarEvento,
  ultimosEventos,
  ultimosRunsPorTipo,
  ultimoSucessoPorTipo,
} from '@rm-toddle/db';
import {
  FLOW,
  FLUXOS_EM_ORDEM,
  acharFluxo,
  avisarAgendaMudou,
  getQueue,
  observarSchedulers,
  resumoDaDlq,
} from '@rm-toddle/queues';
import { atorDaRequisicao, exigirPapel } from '../autorizacao';

/**
 * A TELA DE AGENDAMENTO, do lado do servidor.
 *
 * ─── O QUE ESTAS ROTAS FAZEM E O QUE NÃO FAZEM ──────────────────────────────
 *
 * Elas leem e escrevem a INTENÇÃO (`flow_schedule` no Postgres) e avisam o worker
 * por pub/sub. Nenhuma delas chama `upsertJobScheduler`: quem aplica no Redis é o
 * reconciliador, no worker, e é o único. Três razões: não criar um segundo
 * escritor de scheduler (o risco que a definição duplicada quase produziu), não
 * dar poder de escrita no Redis ao processo exposto na internet, e durabilidade —
 * intenção no Redis evapora num restart sem persistência; no Postgres, não.
 *
 * ─── A TELA MOSTRA OS DOIS ESTADOS, SEMPRE ──────────────────────────────────
 *
 * `GET /agenda` devolve desejado E observado, lado a lado. Não é enfeite: se o
 * Redis reiniciar sem persistência, o scheduler desaparece e NADA dá erro — o
 * worker segue de pé consumindo uma fila que nunca mais recebe nada, e a
 * descoberta vem dias depois pela ausência de dado no Toddle. Uma tela que
 * mostrasse só a intenção seria mais uma superfície capaz de mentir.
 */

/** Pares de fluxos que competem pela mesma janela de rate limit do Toddle. */
const PARES_QUE_COMPETEM: Array<[string, string]> = [[FLOW.ALUNOS, FLOW.PROFESSORES]];

/*
 * Registrado como PLUGIN, e não como função que recebe a instância: a instância
 * é criada com `loggerInstance`, o que especializa o genérico do logger e faz o
 * `FastifyInstance` default deixar de ser atribuível. O tipo de plugin não tem
 * esse acoplamento — e o hook de autenticação do pai continua valendo aqui,
 * porque encapsulamento no Fastify herda hooks para baixo.
 */
export const registrarRotasDeAgenda: FastifyPluginAsync = async (app) => {
  /**
   * O painel: desejado × observado × último run × próximo disparo.
   *
   * Uma chamada só, de propósito. A tela precisa das quatro coisas juntas para
   * dizer algo verdadeiro — "próximo disparo às 03:00" ao lado de "último run:
   * falhou há 3 dias" é uma frase; cada metade sozinha é meia informação.
   */
  app.get('/agenda', { preHandler: exigirPapel(['viewer']) }, async () => {
    const desejada = await listarAgenda();
    const observados = await observarSchedulers();
    const porId = new Map(observados.map((o) => [o.id, o]));
    const tipos = FLUXOS_EM_ORDEM.map((f) => f.key);
    const runs = await ultimosRunsPorTipo(tipos);
    const sucessos = await ultimoSucessoPorTipo(tipos);

    const fluxos = FLUXOS_EM_ORDEM.map((fluxo) => {
      const linha = desejada.find((a) => a.flowKey === fluxo.key) ?? null;
      const obs = porId.get(fluxo.key) ?? null;

      // As divergências, nomeadas. A tela não deveria ter de deduzi-las
      // comparando campos — e se tivesse, cada cliente da API deduziria à sua
      // maneira, e uma delas estaria errada.
      const divergencias: string[] = [];
      if (linha?.ativo && !obs) divergencias.push('ligado no banco e AUSENTE no Redis');
      if (!linha?.ativo && obs) divergencias.push('desligado no banco e PRESENTE no Redis');
      if (linha && obs && linha.cron !== obs.cron) divergencias.push('cron diferente entre banco e Redis');
      if (linha && obs && linha.timezone !== obs.tz) divergencias.push('fuso diferente entre banco e Redis');
      if (linha?.erroAoAplicar) divergencias.push(`erro ao aplicar: ${linha.erroAoAplicar}`);

      /*
       * ─── REVISÃO PENDENTE NÃO É DIVERGÊNCIA ────────────────────────────────
       *
       * `revisaoAplicada < revisao` significa que nenhum worker CONFIRMOU a
       * revisão. Na maior parte das vezes o Redis já está exatamente com o
       * horário desejado — foi o que aconteceu na primeira vez que a tela subiu
       * com login de verdade: o cartão do professor apareceu em vermelho, como
       * DIVERGENTE, com o cron do banco e o do Redis IDÊNTICOS. O que faltava era
       * só o worker passar para marcar.
       *
       * Pintar isso de vermelho é o erro que o conselho avisou: alarme que grita
       * em cima do desenho correto é alarme que alguém aprende a ignorar — e aí
       * some junto com ele a divergência de verdade, que é a que este painel
       * existe para acusar.
       *
       * Então: se o observado JÁ CONFERE com o desejado, a revisão pendente é
       * informação (tipicamente "não há worker de pé"), não defeito. Se o
       * observado não confere, a divergência acima já foi reportada com o motivo
       * exato, e a revisão pendente não acrescenta nada.
       *
       * O reconciliador continua tratando revisão pendente como "aplicar": o
       * upsert é idempotente e barato, e é ele que fecha a janela em que o Redis
       * perdeu o registro sem ninguém notar.
       */
      const observadoConfere = Boolean(
        obs && linha && obs.cron === linha.cron && obs.tz === linha.timezone,
      );
      const revisaoPendente = Boolean(linha && linha.revisaoAplicada !== linha.revisao);

      return {
        flowKey: fluxo.key,
        rotulo: fluxo.rotulo,
        fila: fluxo.fila,
        podeAtivar: fluxo.podeAtivar,
        motivoDoBloqueio: fluxo.motivoDoBloqueio ?? null,
        avisoAoExecutarAgora: fluxo.avisoAoExecutarAgora,
        janelaSemSucessoHoras: fluxo.janelaSemSucessoHoras,
        desejado: linha,
        observado: obs,
        divergencias,
        revisaoPendente,
        observadoConfere,
        proximosDisparos: linha?.ativo ? proximosDisparos(linha.cron, 3) : [],
        ultimoRun: runs[fluxo.key] ?? null,
        ultimoSucessoEm: sucessos[fluxo.key] ?? null,
      };
    });

    return {
      fluxos,
      // Órfão é o registro que ninguém vê: id que não pertence a fluxo nenhum,
      // disparando para sempre sem aparecer em configuração alguma. A troca de
      // agenda produziu três, uma vez, e a reconciliação os varre.
      orfaos: observados.filter((o) => o.desconhecido),
      dlq: await resumoDaDlq(5),
    };
  });

  /**
   * Prévia dos disparos, calculada NO SERVIDOR.
   *
   * O usuário confirma o que vê, não o que digitou. A mesma expressão significa
   * horários diferentes em fusos diferentes, e uma prévia calculada no navegador
   * usaria o fuso da máquina de quem olha — que não é necessariamente o fuso em
   * que o job roda.
   */
  app.post<{ Params: { flowKey: string }; Body: { cron?: string } }>(
    '/agenda/:flowKey/previa',
    { preHandler: exigirPapel(['viewer']) },
    async (req, reply) => {
      const fluxo = acharFluxo(req.params.flowKey);
      if (!fluxo) {
        return reply.code(400).send({ erro: 'fluxo desconhecido', aceitos: FLUXOS_EM_ORDEM.map((f) => f.key) });
      }
      const cron = req.body?.cron;
      if (!cron) return reply.code(400).send({ erro: 'cron é obrigatório no corpo' });

      const validado = validarCron(cron);
      if (!validado.ok) return reply.code(400).send({ erro: validado.erro });

      // A folga contra o outro fluxo do par entra na PRÉVIA, não só no salvar:
      // descobrir a colisão ao clicar em salvar é descobrir tarde.
      const aviso = await avisoDeFolga(fluxo.key, validado.cron);
      return { ...validado, avisoDeFolga: aviso.aviso ?? null, colide: aviso.colide, motivo: aviso.motivo ?? null };
    },
  );

  /**
   * Muda horário e/ou liga/desliga. É a única rota de escrita da agenda.
   *
   * Exige `tenant_admin`: mudar quando o job que escreve no registro acadêmico
   * dispara não é operação de rotina. E grava `audit_event` na MESMA transação —
   * se a auditoria falhar, a mudança falha.
   */
  app.put<{ Params: { flowKey: string }; Body: { cron?: string; ativo?: boolean; motivo?: string } }>(
    '/agenda/:flowKey',
    { preHandler: exigirPapel(['tenant_admin']) },
    async (req, reply) => {
      const fluxo = acharFluxo(req.params.flowKey);
      if (!fluxo) {
        return reply.code(400).send({ erro: 'fluxo desconhecido', aceitos: FLUXOS_EM_ORDEM.map((f) => f.key) });
      }

      const { cron, ativo, motivo } = req.body ?? {};
      if (cron === undefined && ativo === undefined) {
        return reply.code(400).send({ erro: 'informe cron e/ou ativo' });
      }

      // Fluxo bloqueado no catálogo NÃO liga pela tela. Não é zelo excessivo:
      // ligar a via de nota hoje enfileiraria um job cujo processador recusa
      // rodar, e cada disparo cairia na DLQ. Um interruptor que só produz isso
      // não é interruptor, é armadilha — e a tela explica em vez de deixar a
      // pessoa descobrir pela DLQ.
      if (ativo === true && !fluxo.podeAtivar) {
        return reply.code(409).send({
          erro: 'este fluxo não pode ser ativado',
          motivo: fluxo.motivoDoBloqueio,
          ondeMudar: 'packages/queues/src/fluxos.ts — `podeAtivar`, no mesmo commit que redireciona o processador',
        });
      }

      if (cron !== undefined) {
        const validado = validarCron(cron);
        if (!validado.ok) return reply.code(400).send({ erro: validado.erro });

        const folga = await avisoDeFolga(fluxo.key, validado.cron);
        if (folga.colide) {
          return reply.code(409).send({
            erro: 'horário recusado: colide com outro fluxo',
            motivo: folga.motivo,
            menorFolgaMinutos: folga.menorFolgaMinutos,
          });
        }
      }

      const client = await pgPool.connect();
      try {
        await client.query('BEGIN');
        const alterada = await alterarAgenda(client, {
          flowKey: fluxo.key,
          cron: cron === undefined ? undefined : validarCronNormalizado(cron),
          ativo,
          atualizadoPor: req.autorizacao!.userIdentityId,
        });
        if (!alterada) {
          await client.query('ROLLBACK');
          return reply.code(404).send({
            erro: 'este fluxo ainda não tem linha na agenda',
            comoResolver: 'rode `npm run schedule` uma vez para semear a partir do ambiente',
          });
        }

        // MESMA TRANSAÇÃO. Auditoria de melhor esforço é como `audit_event` fica
        // vazia enquanto todos acham que está funcionando.
        await registrarEvento(client, {
          ator: atorDaRequisicao(req),
          acao: 'agenda.alterada',
          entidade: 'flow_schedule',
          entidadeId: fluxo.key,
          antes: { cron: alterada.antes.cron, ativo: alterada.antes.ativo, revisao: alterada.antes.revisao },
          depois: { cron: alterada.depois.cron, ativo: alterada.depois.ativo, revisao: alterada.depois.revisao },
          motivo: motivo ?? undefined,
          resultado: 'ok',
        });
        await client.query('COMMIT');

        // Só DEPOIS do commit: avisar antes seria mandar o worker reconciliar
        // contra uma transação que ainda pode dar rollback.
        await avisarAgendaMudou(fluxo.key);

        logger.warn(
          {
            flowKey: fluxo.key,
            por: req.autorizacao!.userIdentityId,
            antes: { cron: alterada.antes.cron, ativo: alterada.antes.ativo },
            depois: { cron: alterada.depois.cron, ativo: alterada.depois.ativo },
          },
          'AGENDA ALTERADA pela tela',
        );

        return {
          ...alterada,
          proximosDisparos: alterada.depois.ativo ? proximosDisparos(alterada.depois.cron, 5) : [],
          aplicacao:
            'a mudança foi gravada. O worker aplica no Redis ao receber o aviso (segundos) ou no ' +
            'próximo poll — recarregue para ver "observado" acompanhar',
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
  );

  /**
   * SINCRONIZAR AGORA: enfileira UMA execução avulsa, fora do horário.
   *
   * ─── POR QUE A API PODE ESCREVER *ESTE* ITEM NO REDIS ───────────────────
   *
   * O cabeçalho deste arquivo diz que nenhuma rota chama `upsertJobScheduler`, e
   * continua valendo. A razão daquela regra é não existir um SEGUNDO escritor de
   * scheduler, e durabilidade — intenção que evapora num restart do Redis. Um job
   * avulso não é nenhuma das duas coisas: não cria scheduler, e perder um
   * disparo manual num restart é irrelevante, porque a resposta é clicar de novo.
   *
   * ─── UM DE CADA VEZ, POR DOIS MECANISMOS ────────────────────────────────
   *
   * Os workers são `concurrency: 1`, então um segundo job não roda em paralelo:
   * ele espera e roda EM SEGUIDA, reescrevendo o que o primeiro acabou de
   * escrever. Duas defesas, porque uma só não cobre:
   *
   * 1. **`jobId` determinístico por minuto.** Dois cliques no mesmo minuto
   *    produzem o MESMO id, e o BullMQ ignora o segundo `add`. É isto que pega
   *    o clique duplo — a checagem de contagem sozinha não pegaria, porque ela
   *    é TOCTOU: dois pedidos simultâneos leem zero os dois e ambos enfileiram.
   *    O balde de um minuto é curto de propósito: re-rodar de verdade continua
   *    possível, é só esperar o minuto virar.
   *
   * 2. **Contagem do que está pendente.** Recusa com 409 enquanto houver job em
   *    QUALQUER estado não terminal. `waiting`, `active` e `delayed` não bastam:
   *    fila pausada põe o job em `paused`, e a primeira versão desta rota
   *    deixava passar — medido, com a fila pausada, dois `add` seguidos
   *    responderam 200. Por isso soma tudo menos `completed` e `failed`.
   *
   * ─── BLOQUEADO NÃO RODA ─────────────────────────────────────────────────
   *
   * Mesma regra do PUT: fluxo com `podeAtivar: false` não é enfileirável. Um
   * botão que só produz item na DLQ não é botão, é armadilha.
   */
  app.post<{ Params: { flowKey: string }; Body: { motivo?: string } }>(
    '/agenda/:flowKey/executar',
    { preHandler: exigirPapel(['integration_operator']) },
    async (req, reply) => {
      const fluxo = acharFluxo(req.params.flowKey);
      if (!fluxo) {
        return reply.code(400).send({ erro: 'fluxo desconhecido', aceitos: FLUXOS_EM_ORDEM.map((f) => f.key) });
      }
      if (!fluxo.podeAtivar) {
        return reply.code(409).send({
          erro: 'este fluxo não pode ser executado',
          motivo: fluxo.motivoDoBloqueio,
        });
      }

      const fila = getQueue(fluxo.fila);

      // Tudo que não é terminal conta como "já tem um andando".
      const contagem = await fila.getJobCounts();
      const naFila = Object.entries(contagem)
        .filter(([estado]) => estado !== 'completed' && estado !== 'failed')
        .reduce((soma, [, n]) => soma + (n ?? 0), 0);
      if (naFila > 0) {
        return reply.code(409).send({
          erro: 'já existe uma execução deste fluxo na fila',
          naFila,
          estados: contagem,
          comoResolver: 'espere a atual terminar — acompanhe por "último run" no painel',
        });
      }

      // Balde de um minuto: dois cliques dentro dele viram o mesmo job.
      const balde = Math.floor(Date.now() / 60_000);
      const jobId = `manual:${fluxo.key}:${balde}`;
      if (await fila.getJob(jobId)) {
        return reply.code(409).send({
          erro: 'este fluxo já foi disparado manualmente neste minuto',
          jobId,
          comoResolver: 'se foi sem querer, ignore. Para rodar de novo, espere o minuto virar',
        });
      }

      const job = await fila.add(
        fluxo.job,
        {
          trigger: 'manual',
          por: req.autorizacao!.userIdentityId,
          motivo: req.body?.motivo ?? null,
        },
        { jobId },
      );

      // A trilha é do PEDIDO, não do resultado: quem mandou rodar e por quê. O
      // que o job fez sai em `job_run`, que é outra pergunta.
      await registrarEvento(pgPool, {
        ator: atorDaRequisicao(req),
        acao: 'fluxo.executado.manualmente',
        entidade: 'flow_schedule',
        entidadeId: fluxo.key,
        depois: { jobId: job.id ?? null, fila: fluxo.fila, job: fluxo.job },
        motivo: req.body?.motivo ?? undefined,
        resultado: 'ok',
      });

      logger.warn(
        { flowKey: fluxo.key, jobId: job.id, por: req.autorizacao!.userIdentityId },
        'EXECUÇÃO MANUAL enfileirada pela tela',
      );

      return {
        enfileirado: true,
        jobId: job.id ?? null,
        fila: fluxo.fila,
        aplicacao:
          'o job está na fila. Se nenhum worker estiver de pé ele espera lá — ' +
          'acompanhe por "último run" no painel',
      };
    },
  );

  /** Histórico de mudanças. Auditoria que ninguém lê não muda comportamento de ninguém. */
  app.get<{ Querystring: { limite?: string } }>(
    '/auditoria',
    { preHandler: exigirPapel(['viewer']) },
    async (req) => ({ eventos: await ultimosEventos(Number(req.query.limite ?? 50) || 50) }),
  );
};

/** Normaliza espaços do cron antes de gravar, com a mesma regra da validação. */
function validarCronNormalizado(cron: string): string {
  const v = validarCron(cron);
  return v.ok ? v.cron : cron.trim().replace(/\s+/g, ' ');
}

/**
 * A folga contra o outro fluxo do par, avaliada com o cron PROPOSTO.
 *
 * ─── POR QUE ISTO EXISTE ────────────────────────────────────────────────────
 *
 * A janela de rate limit do Toddle é de 300s e os dois syncs de cadastro falam
 * com a MESMA organização; o de aluno leva ~4 min e faz ~260 chamadas. Até aqui a
 * folga de 30 min era garantida por CÁLCULO: o cron do professor era derivado do
 * de aluno somando 30. Com uma tela, a derivação morreu (ela só entendia dois
 * formatos e caía num default em silêncio), e a folga passou a ser VERIFICADA.
 *
 * Verificar é melhor que derivar por um motivo além da segurança: vale para
 * qualquer par de expressões, incluindo as que a regex da derivação nunca
 * entendeu.
 */
async function avisoDeFolga(
  flowKey: string,
  cronProposto: string,
): Promise<{ colide: boolean; menorFolgaMinutos: number; motivo?: string; aviso?: string }> {
  const par = PARES_QUE_COMPETEM.find(([a, b]) => a === flowKey || b === flowKey);
  if (!par) return { colide: false, menorFolgaMinutos: Number.MAX_SAFE_INTEGER };

  const outro = par[0] === flowKey ? par[1] : par[0];
  const agenda = await listarAgenda();
  const linhaDoOutro = agenda.find((a) => a.flowKey === outro);

  // Outro fluxo desligado ou sem linha não compete por nada.
  if (!linhaDoOutro?.ativo) return { colide: false, menorFolgaMinutos: Number.MAX_SAFE_INTEGER };

  return avaliarFolga(cronProposto, linhaDoOutro.cron);
}
