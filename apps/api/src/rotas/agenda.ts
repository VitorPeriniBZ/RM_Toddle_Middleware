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
  ESTADOS_NAO_TERMINAIS,
  acharFluxo,
  avisarAgendaMudou,
  execucoesEmVoo,
  getQueue,
  type JobEmVoo,
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

/*
 * A lista fixa de pares que competiam saiu daqui: quem declara o que disputa é o
 * CATÁLOGO (`recursoDisputado` em packages/queues/src/fluxos.ts). Par vira trio
 * vira quarteto, e uma lista em outro arquivo sempre esquece o fluxo novo — foi
 * o que aconteceu com o de notas, que entrou disputando a mesma janela do Toddle
 * e nunca foi checado contra ninguém.
 */

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
    const leitura = await observarSchedulers();
    const porId = new Map(leitura.observados.map((o) => [o.id, o]));
    // Fila que não deu para ler não é fila sem scheduler. Quem não sabe tem de
    // dizer que não sabe, senão a tela acusa divergência inventada.
    const filasIlegiveis = new Set(leitura.ilegiveis.map((i) => i.fila));
    const tipos = FLUXOS_EM_ORDEM.map((f) => f.key);
    const runs = await ultimosRunsPorTipo(tipos);
    const sucessos = await ultimoSucessoPorTipo(tipos);

    /**
     * Já existe execução em voo? A tela precisa saber ANTES de oferecer o botão.
     *
     * O POST recusa com 409 de qualquer jeito — essa é a guarda de verdade, e
     * continua sendo, porque entre esta leitura e o clique passa tempo. Isto
     * aqui é para o botão nascer desabilitado em vez de a pessoa descobrir pelo
     * erro vermelho. Um botão que só serve para produzir recusa é ruído.
     */
    const emVooPorFluxo = new Map<string, { quantidade: number; desde: string | null }>();
    await Promise.all(
      FLUXOS_EM_ORDEM.map(async (fluxo) => {
        const fila = getQueue(fluxo.fila);
        const naFila = await fila.getJobs([...ESTADOS_NAO_TERMINAIS]);
        const comEstado = await Promise.all(
          naFila.map(async (j) => ({
            job: j,
            estado: (await j.getState()) as
              | 'waiting' | 'active' | 'delayed' | 'paused' | 'prioritized',
            repeatJobKey: (j as { repeatJobKey?: string | null }).repeatJobKey ?? null,
          })),
        );
        // O marcador do próximo cron é `delayed` permanente e NÃO é trabalho.
        const emVoo = comEstado.filter(
          (x) => execucoesEmVoo([{ estado: x.estado, repeatJobKey: x.repeatJobKey }]).length > 0,
        );
        if (emVoo.length === 0) return;
        const inicios = emVoo.map((x) => x.job.processedOn ?? x.job.timestamp).filter(Boolean);
        emVooPorFluxo.set(fluxo.key, {
          quantidade: emVoo.length,
          desde: inicios.length ? new Date(Math.min(...(inicios as number[]))).toISOString() : null,
        });
      }),
    );

    const fluxos = FLUXOS_EM_ORDEM.map((fluxo) => {
      const linha = desejada.find((a) => a.flowKey === fluxo.key) ?? null;
      const obs = porId.get(fluxo.key) ?? null;

      // As divergências, nomeadas. A tela não deveria ter de deduzi-las
      // comparando campos — e se tivesse, cada cliente da API deduziria à sua
      // maneira, e uma delas estaria errada.
      const divergencias: string[] = [];
      // Não dá para comparar com o que não foi lido. Acusar divergência aqui
      // apontaria para o fluxo errado — o problema é o Redis, não a agenda.
      const naoObservavel = filasIlegiveis.has(fluxo.fila);

      if (naoObservavel) {
        divergencias.push(
          'NÃO FOI POSSÍVEL LER O REDIS desta fila — o que está agendado é desconhecido, ' +
            'e isto não é o mesmo que "sem agendamento"',
        );
      } else {
        if (linha?.ativo && !obs) divergencias.push('ligado no banco e AUSENTE no Redis');
        if (!linha?.ativo && obs) divergencias.push('desligado no banco e PRESENTE no Redis');
        if (linha && obs && linha.cron !== obs.cron) divergencias.push('cron diferente entre banco e Redis');
        if (linha && obs && linha.timezone !== obs.tz) divergencias.push('fuso diferente entre banco e Redis');
      }
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
        /** `null` = nada rodando. Preenchido = o botão de rodar agora fica travado. */
        execucaoEmVoo: emVooPorFluxo.get(fluxo.key) ?? null,
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
      orfaos: leitura.observados.filter((o) => o.desconhecido),
      // As filas que não deu para ler vão para a tela junto: sem isto, o painel
      // afirmaria "0 órfãos" tendo perguntado a menos filas do que existe.
      filasIlegiveis: leitura.ilegiveis,
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

      // A folga é checada no horário que VAI VALER — o proposto, ou o que já
      // está gravado quando só se está ligando.
      //
      // Ligar também passa por aqui, e é o caso que faltava: um cron colidente
      // dorme inofensivo enquanto o fluxo está desligado e acorda no momento em
      // que alguém liga. Foi exatamente assim que o de notas entrou em rota de
      // colisão com os outros dois sem ninguém ser avisado.
      const vaiFicarAtivo = ativo ?? (await listarAgenda()).find((a) => a.flowKey === fluxo.key)?.ativo;
      if (cron !== undefined) {
        const validado = validarCron(cron);
        if (!validado.ok) return reply.code(400).send({ erro: validado.erro });
      }
      if (vaiFicarAtivo) {
        const cronEfetivo =
          cron !== undefined
            ? validarCronNormalizado(cron)
            : (await listarAgenda()).find((a) => a.flowKey === fluxo.key)?.cron;
        if (cronEfetivo) {
          const folga = await avisoDeFolga(fluxo.key, cronEfetivo);
          if (folga.colide) {
            return reply.code(409).send({
              erro: 'horário recusado: colide com outro fluxo',
              motivo: folga.motivo,
              comQuem: folga.comQuem,
              menorFolgaMinutos: folga.menorFolgaMinutos,
              comoResolver:
                'escolha um horário mais distante, ou desligue o outro fluxo antes — ' +
                'os dois disputam a mesma janela de 300s do Toddle',
            });
          }
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

      // Os jobs de verdade, não a contagem: o Job Scheduler mantém um job
      // `delayed` PERMANENTE reservando o próximo disparo do cron, e contá-lo
      // tornava este botão inútil em todo fluxo ligado. A regra está em
      // `execucoesEmVoo`, com teste — errei isto duas vezes escrevendo inline.
      const naFila = await fila.getJobs([...ESTADOS_NAO_TERMINAIS]);
      // `getState()` em vez de inferir por `opts.delay` ou pelo prefixo do id:
      // o estado real é o que a regra precisa, e são poucos jobs por fila.
      const emVoo = execucoesEmVoo(
        await Promise.all(
          naFila.map(async (j) => ({
            estado: (await j.getState()) as JobEmVoo['estado'],
            repeatJobKey: (j as { repeatJobKey?: string | null }).repeatJobKey ?? null,
          })),
        ),
      );
      if (emVoo.length > 0) {
        return reply.code(409).send({
          erro: 'já existe uma execução deste fluxo na fila',
          naFila: emVoo.length,
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
        // NÃO prometer "último run": um job que roda e não faz nada (via
        // desligada) retorna antes de abrir run, e nunca apareceria ali. Quem
        // mostra todo desfecho é a aba Jobs, que lê a fila além do `job_run`.
        aplicacao:
          'o job está na fila. Acompanhe na aba Jobs — ela mostra o que terminou ' +
          'nas últimas 24h, inclusive job que rodou e não fez nada',
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
/**
 * O horário proposto se atrapalha com algum outro fluxo ATIVO?
 *
 * ─── COMPARA CONTRA TODOS, E DEVOLVE O PIOR ─────────────────────────────────
 *
 * Não existe mais "o outro fluxo": existem todos os que declaram o mesmo
 * `recursoDisputado`. A resposta é a PIOR folga encontrada, porque basta uma
 * sobreposição para os dois falharem por 429 — a janela do Toddle é da
 * organização, não do fluxo.
 *
 * Fluxo desligado não compete: ele não dispara. Por isso a checagem tem de rodar
 * também na hora de LIGAR (ver o PUT), e não só ao mudar o cron — ligar é
 * justamente o momento em que uma colisão adormecida acorda.
 */
async function avisoDeFolga(
  flowKey: string,
  cronProposto: string,
): Promise<{
  colide: boolean;
  menorFolgaMinutos: number;
  motivo?: string;
  aviso?: string;
  comQuem?: string;
}> {
  const fluxo = acharFluxo(flowKey);
  if (!fluxo?.recursoDisputado) {
    return { colide: false, menorFolgaMinutos: Number.MAX_SAFE_INTEGER };
  }

  const concorrentes = FLUXOS_EM_ORDEM.filter(
    (f) => f.key !== flowKey && f.recursoDisputado === fluxo.recursoDisputado,
  );
  if (concorrentes.length === 0) {
    return { colide: false, menorFolgaMinutos: Number.MAX_SAFE_INTEGER };
  }

  const agenda = await listarAgenda();
  let pior: {
    colide: boolean;
    menorFolgaMinutos: number;
    motivo?: string;
    aviso?: string;
    comQuem?: string;
  } = { colide: false, menorFolgaMinutos: Number.MAX_SAFE_INTEGER };

  for (const outro of concorrentes) {
    const linha = agenda.find((a) => a.flowKey === outro.key);
    if (!linha?.ativo) continue; // desligado não dispara, logo não compete

    const r = avaliarFolga(cronProposto, linha.cron);
    if (r.menorFolgaMinutos < pior.menorFolgaMinutos) {
      pior = { ...r, comQuem: outro.rotulo };
    }
  }
  return pior;
}
