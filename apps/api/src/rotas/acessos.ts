import type { FastifyPluginAsync } from 'fastify';
import { logger } from '@rm-toddle/config';
import {
  PAPEIS,
  RecusaDeAcesso,
  concederPapelAExistente,
  listarAcessos,
  listarIdentidadesSemPapel,
  quantosAdministram,
  revogarPapel,
  type Papel,
} from '@rm-toddle/db';
import { atorDaRequisicao, exigirPapel } from '../autorizacao';

/**
 * A TELA DE ACESSOS, do lado do servidor.
 *
 * ─── O QUE ELA NÃO MUDA ─────────────────────────────────────────────────────
 *
 * A propriedade de bootstrap continua de pé, e é fácil achar que a tela a
 * quebra. Conceder aqui exige `tenant_admin`; `membership` nasce vazia; logo
 * ninguém consegue abrir esta tela até que `npm run conceder` crie o primeiro
 * administrador por fora. A porta segue trancada — a tela só evita SSH do
 * segundo acesso em diante.
 *
 * ─── POR QUE NÃO HÁ "CONVIDAR POR E-MAIL" ───────────────────────────────────
 *
 * A identidade é a claim `sub` do Google, que só existe depois do primeiro
 * login e que ninguém sabe de cor. Convite por e-mail exigiria casar convite com
 * login pelo endereço — e e-mail muda, então o convite para o endereço antigo
 * casaria com a pessoa errada no dia da renomeação.
 *
 * O caminho honesto já existia: `exigirPapel` cria a `user_identity` ANTES de
 * checar papel, então quem tentou entrar e levou 403 já está no banco. A tela
 * mostra essa fila como "aguardando acesso" e concede dali — sem ninguém digitar
 * um `sub`.
 */

/** Corpo de concessão e de revogação. Mesmo formato, verbos diferentes. */
interface CorpoDeMudanca {
  userIdentityId?: string;
  papel?: string;
  motivo?: string;
}

function papelValido(v: unknown): v is Papel {
  return typeof v === 'string' && (PAPEIS as readonly string[]).includes(v);
}

export const registrarRotasDeAcessos: FastifyPluginAsync = async (app) => {
  /**
   * Quem tem acesso, e quem está esperando.
   *
   * As duas listas numa chamada só porque a decisão é uma só: olhar quem espera
   * e decidir o que dar. Em duas chamadas a tela teria dois estados de carga
   * para uma pergunta.
   *
   * Exige `tenant_admin` inclusive para LER: a lista diz quem administra a
   * integração da escola, e isso não é informação de painel — é o mapa de quem
   * vale a pena atacar.
   */
  app.get('/acessos', { preHandler: exigirPapel(['tenant_admin']) }, async () => {
    const [comAcesso, aguardando] = await Promise.all([
      listarAcessos(),
      listarIdentidadesSemPapel(),
    ]);
    return {
      papeis: PAPEIS,
      comAcesso,
      aguardando,
      /*
       * Quantos administram, para a tela poder AVISAR ANTES de o clique falhar.
       * Com um só, o botão de remover `tenant_admin` aparece desabilitado e
       * explicado, em vez de recusado depois — recusa depois do clique ensina a
       * pessoa a clicar e ver no que dá.
       */
      administradores: await quantosAdministram(),
    };
  });

  /**
   * Concede um papel a quem já tem identidade.
   *
   * ─── QUEM CONCEDE NÃO ESCALA A SI MESMO, E ISSO NÃO É REDUNDANTE ──────────
   *
   * `exigirPapel(['tenant_admin'])` já garante que só administrador chega aqui,
   * e administrador pode tudo — então "escalar o próprio papel" parece sem
   * sentido. A guarda existe pelo caso em que ele deixa de ser: `tenant_admin`
   * satisfaz qualquer exigência HOJE, por uma regra de uma linha em
   * `autorizacao.ts`. No dia em que alguém introduzir um papel acima, ou tornar
   * a checagem mais fina, uma rota que aceita conceder a si mesmo vira escalada
   * de privilégio — e ninguém revisa esta rota nesse dia.
   *
   * O custo é um `if`; o benefício é que a trilha de auditoria nunca tem o mesmo
   * nome dos dois lados de uma concessão.
   */
  app.post<{ Body: CorpoDeMudanca }>(
    '/acessos',
    { preHandler: exigirPapel(['tenant_admin']) },
    async (req, reply) => {
      const { userIdentityId, papel, motivo } = req.body ?? {};

      if (!userIdentityId || typeof userIdentityId !== 'string') {
        return reply.code(400).send({
          erro: 'userIdentityId é obrigatório',
          comoResolver: 'escolha alguém da lista — a identidade vem de GET /acessos',
        });
      }
      if (!papelValido(papel)) {
        return reply.code(400).send({ erro: 'papel inválido', aceitos: PAPEIS });
      }
      if (userIdentityId === req.autorizacao?.userIdentityId) {
        return reply.code(400).send({
          erro: 'não dá para conceder papel a si mesmo',
          comoResolver:
            'peça a outro tenant_admin, ou use `npm run conceder` na máquina do middleware',
          detalhe:
            'quem decide e quem recebe não podem ser a mesma pessoa — a mesma regra que o gate ' +
            'de aprovação usa',
        });
      }

      try {
        const { jaTinha } = await concederPapelAExistente({
          userIdentityId,
          papel,
          ator: atorDaRequisicao(req),
          motivo,
        });
        logger.info(
          { alvo: userIdentityId, papel, por: req.autorizacao?.userIdentityId, jaTinha },
          jaTinha ? 'Papel já existia — nada mudou' : 'Papel concedido',
        );
        return { ok: true, jaTinha, papel };
      } catch (e) {
        if (e instanceof RecusaDeAcesso) {
          return reply.code(409).send({ erro: e.message, comoResolver: e.comoResolver });
        }
        throw e;
      }
    },
  );

  /**
   * Revoga um papel.
   *
   * DELETE com corpo é malvisto e alguns proxies o descartam, então a revogação
   * é um POST em `/acessos/revogar`. Perder o corpo aqui não seria um erro
   * barulhento: seria uma revogação que responde 200 e não revoga.
   */
  app.post<{ Body: CorpoDeMudanca }>(
    '/acessos/revogar',
    { preHandler: exigirPapel(['tenant_admin']) },
    async (req, reply) => {
      const { userIdentityId, papel, motivo } = req.body ?? {};

      if (!userIdentityId || typeof userIdentityId !== 'string') {
        return reply.code(400).send({ erro: 'userIdentityId é obrigatório' });
      }
      if (!papelValido(papel)) {
        return reply.code(400).send({ erro: 'papel inválido', aceitos: PAPEIS });
      }

      try {
        const { naoTinha } = await revogarPapel({
          userIdentityId,
          papel,
          ator: atorDaRequisicao(req),
          motivo,
        });
        logger.info(
          { alvo: userIdentityId, papel, por: req.autorizacao?.userIdentityId, naoTinha },
          naoTinha ? 'Papel não existia — nada mudou' : 'Papel revogado',
        );
        return { ok: true, naoTinha, papel };
      } catch (e) {
        if (e instanceof RecusaDeAcesso) {
          return reply.code(409).send({ erro: e.message, comoResolver: e.comoResolver });
        }
        throw e;
      }
    },
  );
};
