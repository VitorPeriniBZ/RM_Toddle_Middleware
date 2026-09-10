import Fastify from 'fastify';
import cors from '@fastify/cors';
import { configVersion, configVersionDetalhe, env, logger, tenantConfig } from '@rm-toddle/config';
import { pgPool, idMappingRepository, ENTITY_TYPES, type EntityType } from '@rm-toddle/db';
import { toddleClient } from '@rm-toddle/integrations';
import { autenticar } from './auth';
import { exigirPapel } from './autorizacao';
import { registrarRotasDeAgenda } from './rotas/agenda';
import { registrarRotasDeVinculos } from './rotas/vinculos';

/** Config da escola atendida por este processo. Ver packages/config/src/tenantConfig.ts. */
const cfg = tenantConfig;

/**
 * Plano de CONTROLE.
 *
 * ─── O QUE PASSOU A ESCREVER, E COM QUE FREIOS ──────────────────────────────
 *
 * A primeira fatia era só leitura. Agora existem rotas de escrita, e cada uma
 * respeita o desenho que já estava no schema desde a migration 006:
 *
 *   agenda      escreve INTENÇÃO em `flow_schedule` e avisa o worker. NÃO toca o
 *               Redis: quem aplica o scheduler é o reconciliador, e é o único.
 *   vínculo      NÃO escreve em `id_mapping`. Cria `operation` com payload
 *               congelado e `source_snapshot`; aplicar exige decisão com o
 *               snapshot revalidado.
 *   RM / Toddle  nada. Nenhuma rota desta API escreve nos sistemas do cliente.
 *
 * Toda escrita passa por `exigirPapel` e grava `audit_event` na MESMA transação
 * da mudança — se a auditoria falhar, a mudança falha.
 *
 * ─── AUTENTICAÇÃO NÃO É AUTORIZAÇÃO ────────────────────────────────────────
 *
 * `auth.ts` responde "quem é" (assinatura, audience, expiração, claim `hd` do
 * Workspace). `autorizacao.ts` responde "pode o quê", e a resposta vem de
 * `membership`. Todo mundo da escola autentica; "todo mundo da escola" não é
 * "quem pode mudar o job que escreve nota no RM".
 *
 * A negação é por padrão, inclusive na leitura: sem linha em `membership`,
 * nenhuma rota protegida responde. A primeira concessão é por script
 * (`npm run conceder`), fora da tela — uma porta que abre a si mesma não é porta.
 *
 * LIMITAÇÃO CONSCIENTE: o tenant vem de TENANT_SLUG no ambiente, igual ao worker
 * — nenhuma rota aceita tenant por parâmetro. Continua honesto: a arquitetura é
 * deploy-por-tenant, e o dia em que não for, o tenant sairá do vínculo do
 * usuário, nunca do cliente.
 */
export function construirApp() {
  const app = Fastify({ loggerInstance: logger });

  /*
   * CORS por ALLOWLIST, nunca "*". A UI roda em outra origem (Vite na 5173) e
   * precisa mandar o header Authorization; com origem liberada para qualquer
   * site, qualquer página aberta no navegador do usuário poderia chamar esta API
   * usando o token dele.
   *
   * localhost e 127.0.0.1 são origens DIFERENTES para o navegador (e para o
   * Google), então as duas entram — senão o login falha por origin_mismatch
   * dependendo de como a página foi aberta.
   */
  const origensPermitidas = env.WEB_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  void app.register(cors, {
    origin: origensPermitidas,
    methods: ['GET', 'POST', 'PUT'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  });

  // Autentica tudo, exceto o health check — que precisa responder para o
  // orquestrador mesmo quando a autenticação está mal configurada.
  app.addHook('onRequest', async (req, reply) => {
    const publicas = ['/health', '/auth/config'];
    if (publicas.some((r) => req.url === r || req.url.startsWith(r + '?'))) return;
    await autenticar(req, reply);
  });

  /** Vivacidade + dependências. Sem autenticação, sem PII. */
  app.get('/health', async () => {
    const checar = async (nome: string, fn: () => Promise<unknown>) => {
      try { await fn(); return { nome, ok: true }; }
      catch (e) { return { nome, ok: false, erro: e instanceof Error ? e.message.slice(0, 160) : String(e) }; }
    };
    const deps = await Promise.all([
      checar('postgres', () => pgPool.query('SELECT 1')),
      checar('toddle', () => toddleClient.assertTargetOrganization()),
    ]);
    return {
      ok: deps.every((d) => d.ok),
      authMode: env.API_AUTH_MODE,
      tenant: cfg.slug,
      configVersion: configVersion(),
      dependencias: deps,
    };
  });

  /**
   * Configuração que a UI precisa para montar o login. SEM autenticação, de
   * propósito: o client ID do Google é público por desenho — ele aparece nas
   * requisições do navegador de qualquer forma.
   *
   * Expor por aqui evita duplicar o valor num VITE_* e, principalmente, evita
   * afrouxar o envPrefix do Vite, o que arriscaria varrer TODDLE_TOKEN e
   * RM_WS_PASS para dentro do bundle.
   */
  app.get('/auth/config', async () => ({
    authMode: env.API_AUTH_MODE,
    clientId: env.API_AUTH_MODE === 'google-oidc' ? env.GOOGLE_CLIENT_ID : null,
  }));

  /** Configuração de escopo/destino em vigor. Nenhum segredo é exposto. */
  app.get('/config', { preHandler: exigirPapel(['viewer']) }, async () => configVersionDetalhe());

  /** Contagem de mapeamentos por tipo e estado — o panorama que eu lia via psql. */
  app.get('/mappings/summary', { preHandler: exigirPapel(['viewer']) }, async () => {
    const { rows } = await pgPool.query<{ entity_type: string; state: string; total: string }>(
      `SELECT m.entity_type, m.state, count(*)::text AS total
         FROM id_mapping m
         JOIN tenant t ON t.id = m.tenant_id
        WHERE t.slug = $1
        GROUP BY 1, 2 ORDER BY 1, 2`,
      [cfg.slug],
    );
    return {
      tenant: cfg.slug,
      itens: rows.map((r) => ({ entityType: r.entity_type, state: r.state, total: Number(r.total) })),
    };
  });

  /**
   * Lista mapeamentos de um tipo. Sem PII: devolve códigos e ids, não nomes.
   * `limit` existe para a UI não pedir 1.033 linhas por acidente.
   */
  app.get<{ Querystring: { entityType?: string; state?: string; limit?: string } }>(
    '/mappings',
    { preHandler: exigirPapel(['viewer']) },
    async (req, reply) => {
      const { entityType, state, limit } = req.query;
      if (!entityType || !ENTITY_TYPES.includes(entityType as EntityType)) {
        return reply.code(400).send({
          erro: 'entityType inválido ou ausente',
          aceitos: ENTITY_TYPES,
        });
      }
      if (state && state !== 'active' && state !== 'archived') {
        return reply.code(400).send({ erro: 'state deve ser "active" ou "archived"' });
      }
      const max = Math.min(Number(limit ?? 200) || 200, 500);
      const todos = await idMappingRepository.listByType(
        entityType as EntityType,
        state as 'active' | 'archived' | undefined,
      );
      return {
        entityType, state: state ?? 'todos',
        total: todos.length,
        truncado: todos.length > max,
        itens: todos.slice(0, max).map((m) => ({
          rmCode: m.rmCode,
          toddleId: m.toddleId,
          state: m.state,
          curriculumId: m.curriculumId,
          archiveReason: m.archiveReason,
          lastSeenInScopeAt: m.lastSeenInScopeAt,
        })),
      };
    },
  );

  /**
   * Year groups mapeados, cruzados com o que o Toddle diz AGORA — a auditoria
   * que eu fazia por script. Responde "algum mapeamento aponta para id que não
   * existe mais, ou para a escada de currículo errada?".
   */
  app.get<{ Querystring: { curriculumId?: string } }>(
    '/pendencias/year-groups',
    { preHandler: exigirPapel(['viewer']) },
    async (req, reply) => {
    const { curriculumId } = req.query;
    if (!curriculumId) {
      return reply.code(400).send({
        erro: 'curriculumId é obrigatório',
        motivo:
          'sem currículo a API devolve a organização achatada, onde nomes de year group ' +
          'colidem entre currículos — foi assim que um de-para foi feito para a escada errada',
      });
    }
    const doToddle = await toddleClient.getYearGroups(curriculumId);
    const validos = new Map(doToddle.map((y) => [y.id, y]));
    const mapeados = await idMappingRepository.listByType('YEAR_GROUP');

    return {
      curriculumId,
      yearGroupsNoToddle: doToddle.length,
      mapeamentos: mapeados.length,
      problemas: mapeados
        .filter((m) => !validos.has(m.toddleId) || (m.curriculumId && m.curriculumId !== curriculumId))
        .map((m) => ({
          rmCode: m.rmCode,
          toddleId: m.toddleId,
          curriculumIdRegistrado: m.curriculumId,
          causa: !validos.has(m.toddleId)
            ? 'id não existe neste currículo do Toddle'
            : 'mapeamento registrado em outro currículo',
        })),
      };
    },
  );

  // Agenda (painel, prévia, horário, liga/desliga, auditoria) e de-para
  // (busca, duplicata, órfão, proposta, decisão). Em módulos separados porque
  // são dois assuntos, e um arquivo de rotas que cresce sem divisão é onde a
  // próxima rota entra sem `exigirPapel` e ninguém percebe na revisão.
  void app.register(registrarRotasDeAgenda);
  void app.register(registrarRotasDeVinculos);

  return app;
}
