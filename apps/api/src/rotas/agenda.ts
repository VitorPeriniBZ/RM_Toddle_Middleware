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
      if (linha && linha.revisaoAplicada !== linha.revisao) {
        divergencias.push(`revisão ${linha.revisao} pendente de aplicação`);
      }
      if (linha?.erroAoAplicar) divergencias.push(`erro ao aplicar: ${linha.erroAoAplicar}`);

      return {
        flowKey: fluxo.key,
        rotulo: fluxo.rotulo,
        fila: fluxo.fila,
        podeAtivar: fluxo.podeAtivar,
        motivoDoBloqueio: fluxo.motivoDoBloqueio ?? null,
        janelaSemSucessoHoras: fluxo.janelaSemSucessoHoras,
        desejado: linha,
        observado: obs,
        divergencias,
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
