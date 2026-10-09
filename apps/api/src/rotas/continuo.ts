import type { FastifyPluginAsync } from 'fastify';
import { logger } from '@rm-toddle/config';
import {
  alterarDetector,
  listarAgenda,
  listarDetectores,
  pgPool,
  registrarEvento,
  semearDetector,
} from '@rm-toddle/db';
import { estadoDaCotaDoToddle } from '@rm-toddle/integrations';
import {
  DETECTORES_EM_ORDEM, acharDetector, acharFluxo, liberarTravaDoRm, travaDoRm,
} from '@rm-toddle/queues';
import { atorDaRequisicao, exigirPapel } from '../autorizacao';
import { janelaLegivel, situacaoDoDetector } from '../situacaoDoDetector';

/**
 * TEMPO QUASE REAL, do lado do servidor.
 *
 * Mesma divisão da agenda: estas rotas leem e gravam a INTENÇÃO
 * (`fluxo_continuo`) e devolvem o que o worker OBSERVOU. Nenhuma sonda, nenhum
 * job: quem pergunta ao Toddle e ao RM é o laço no worker, e quem escreve é o
 * fluxo que ele dispara. A API não ganha nenhum poder novo sobre RM ou Toddle.
 */
export const registrarRotasDeContinuo: FastifyPluginAsync = async (app) => {
  /**
   * O painel: cada detector com intenção, observação, situação e os fluxos que
   * ele dispara — e a cota do Toddle, que é o recurso que o tempo quase real
   * mais pressiona.
   */
  app.get('/continuo', { preHandler: exigirPapel(['viewer']) }, async () => {
    const agora = new Date();
    const [linhas, agenda, cota, trava] = await Promise.all([
      listarDetectores(), listarAgenda(), estadoDaCotaDoToddle(), travaDoRm(),
    ]);
    const ligado = new Map(agenda.map((a) => [a.flowKey, a.ativo]));

    return {
      agora: agora.toISOString(),
      cota,
      /** A trava de credencial do RM, que pausa TODOS os detectores. */
      travaDoRm: trava ? { ate: trava.ate, recusas: trava.recusas, motivo: trava.motivo } : null,
      detectores: DETECTORES_EM_ORDEM.map((def) => {
        const linha = linhas.find((l) => l.chave === def.chave) ?? null;
        const { situacao, explicacao } = situacaoDoDetector(linha, agora, trava);
        return {
          chave: def.chave,
          rotulo: def.rotulo,
          direcao: def.direcao,
          pergunta: def.pergunta,
          custoPorVolta: def.custoPorVolta,
          avisoAoLigar: def.avisoAoLigar,
          padrao: def.padrao,
          fluxos: def.fluxos.map((key) => ({
            key,
            rotulo: acharFluxo(key)?.rotulo ?? key,
            ligado: ligado.get(key) ?? false,
          })),
          situacao,
          explicacao,
          janela: linha ? janelaLegivel(linha.horaInicio, linha.horaFim) : null,
          linha,
        };
      }),
    };
  });

  /**
   * Liga, desliga, muda intervalo ou horário. `tenant_admin`, e audita na MESMA
   * transação — ligar um detector de nota é decidir que nota passa a chegar ao
   * registro acadêmico de minuto em minuto.
   */
  app.put<{
    Params: { chave: string };
    Body: {
      ativo?: boolean;
      intervaloSegundos?: number;
      horaInicio?: number;
      horaFim?: number;
      /** Limpa pausa, falhas e a trava de credencial do RM — "a senha foi corrigida". */
      retomar?: boolean;
      motivo?: string;
    };
  }>('/continuo/:chave', { preHandler: exigirPapel(['tenant_admin']) }, async (req, reply) => {
    const def = acharDetector(req.params.chave);
    if (!def) {
      return reply.code(400).send({
        erro: 'detector desconhecido',
        aceitos: DETECTORES_EM_ORDEM.map((d) => d.chave),
      });
    }

    const { ativo, intervaloSegundos, horaInicio, horaFim, retomar, motivo } = req.body ?? {};
    if (
      ativo === undefined && intervaloSegundos === undefined && horaInicio === undefined &&
      horaFim === undefined && retomar !== true
    ) {
      return reply.code(400).send({ erro: 'informe ativo, intervaloSegundos, horaInicio, horaFim e/ou retomar' });
    }
    if (ativo !== undefined && typeof ativo !== 'boolean') {
      return reply.code(400).send({ erro: '`ativo` tem de ser true ou false' });
    }
    if (
      intervaloSegundos !== undefined &&
      (!Number.isInteger(intervaloSegundos) || intervaloSegundos < 30 || intervaloSegundos > 3600)
    ) {
      return reply.code(400).send({
        erro: 'intervalo fora do permitido',
        aceito: 'inteiro de 30 a 3600 segundos',
        porque: 'abaixo de 30 s a sonda passa a pesar na cota do Toddle; acima de 1 h a agenda comum já serve',
      });
    }
    for (const [nome, h] of [['horaInicio', horaInicio], ['horaFim', horaFim]] as const) {
      if (h !== undefined && (!Number.isInteger(h) || h < 0 || h > 23)) {
        return reply.code(400).send({ erro: `${nome} tem de ser uma hora inteira de 0 a 23` });
      }
    }

    // Ligar um detector cujos fluxos estão TODOS desligados produziria só
    // "mudou → fluxo desligado", para sempre. Um interruptor que não faz nada
    // não é interruptor, é armadilha — a tela explica em vez de deixar ligar.
    if (ativo === true) {
      const agenda = await listarAgenda();
      const algumLigado = def.fluxos.some((f) => agenda.find((a) => a.flowKey === f)?.ativo);
      if (!algumLigado) {
        return reply.code(409).send({
          erro: 'nenhum fluxo que este detector dispara está ligado na agenda',
          fluxos: def.fluxos.map((f) => acharFluxo(f)?.rotulo ?? f),
          comoResolver: 'ligue o fluxo na agenda primeiro — o detector só antecipa o que a agenda já faz',
        });
      }
    }

    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      // A linha nasce pelo worker, mas a tela não pode depender disso para
      // funcionar logo depois de um deploy: semeia aqui também, desligada.
      await semearDetector(def.chave, def.padrao, client);
      const alterado = await alterarDetector(client, {
        chave: def.chave,
        ativo,
        intervaloSegundos,
        horaInicio,
        horaFim,
        retomar,
        atualizadoPor: req.autorizacao!.userIdentityId,
      });
      if (!alterado) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ erro: 'linha do detector não encontrada' });
      }
      // A trava do RM mora no Redis, fora da transação. Retomar a libera mesmo
      // que a linha não tenha mudado: a pausa que a pessoa vê pode ser só ela.
      const tinhaTrava = retomar === true ? Boolean(await travaDoRm()) : false;
      // Nada mudou e nada a liberar: não há o que auditar. Um evento com
      // "antes" igual a "depois" é ruído que ensina a não ler a auditoria.
      if (alterado.antes === alterado.depois && !tinhaTrava) {
        await client.query('ROLLBACK');
        return { ...alterado, semMudanca: true, aplicacao: 'nada mudou' };
      }

      const resumo = (d: typeof alterado.antes) => ({
        ativo: d.ativo,
        intervaloSegundos: d.intervaloSegundos,
        horaInicio: d.horaInicio,
        horaFim: d.horaFim,
      });
      await registrarEvento(client, {
        ator: atorDaRequisicao(req),
        acao: 'continuo.alterado',
        entidade: 'fluxo_continuo',
        entidadeId: def.chave,
        antes: { ...resumo(alterado.antes), ...(retomar ? { pausadoAte: alterado.antes.pausadoAte, travaDoRm: tinhaTrava } : {}) },
        depois: { ...resumo(alterado.depois), ...(retomar ? { retomado: true } : {}) },
        motivo: motivo ?? undefined,
        resultado: 'ok',
      });
      await client.query('COMMIT');
      // Depois do commit: liberar antes e ver a auditoria falhar deixaria a
      // trava solta sem registro de quem soltou.
      if (tinhaTrava) await liberarTravaDoRm();

      logger.warn(
        { detector: def.chave, por: req.autorizacao!.userIdentityId, antes: resumo(alterado.antes), depois: resumo(alterado.depois) },
        'DETECTOR ALTERADO pela tela',
      );

      return {
        ...alterado,
        aplicacao:
          'gravado. O worker relê a linha a cada volta (até 30 s quando desligado), então a mudança vale ' +
          'na próxima volta, sem redeploy',
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });
};
