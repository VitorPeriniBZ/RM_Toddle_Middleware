import Fastify from 'fastify';
import cors from '@fastify/cors';
import { env, logger, configVersion, configVersionDetalhe } from '@rm-toddle/config';
import { pgPool, idMappingRepository, ENTITY_TYPES, type EntityType } from '@rm-toddle/db';
import { toddleClient } from '@rm-toddle/integrations';
import { autenticar } from './auth';

/**
 * Plano de CONTROLE. Só leitura nesta primeira fatia — nenhuma rota escreve, nem
 * no nosso banco nem no RM/Toddle. Escrita entra como máquina de operações
 * aprováveis (tabelas `operation`/`approval`, migration 006), não como rota solta.
 *
 * LIMITAÇÃO CONSCIENTE DA v1: o tenant vem de TENANT_SLUG no ambiente, igual ao
 * worker — nenhuma rota aceita tenant por parâmetro. Isso é honesto: não há
 * ilusão de multi-tenancy antes de existir `membership`. Quando a autorização
 * existir, o tenant sairá do vínculo do usuário, nunca do cliente.
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
      tenant: env.TENANT_SLUG,
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
  app.get('/config', async () => configVersionDetalhe());

  /** Contagem de mapeamentos por tipo e estado — o panorama que eu lia via psql. */
  app.get('/mappings/summary', async () => {
    const { rows } = await pgPool.query<{ entity_type: string; state: string; total: string }>(
      `SELECT m.entity_type, m.state, count(*)::text AS total
         FROM id_mapping m
         JOIN tenant t ON t.id = m.tenant_id
        WHERE t.slug = $1
        GROUP BY 1, 2 ORDER BY 1, 2`,
      [env.TENANT_SLUG],
    );
    return {
      tenant: env.TENANT_SLUG,
      itens: rows.map((r) => ({ entityType: r.entity_type, state: r.state, total: Number(r.total) })),
    };
  });

  /**
   * Lista mapeamentos de um tipo. Sem PII: devolve códigos e ids, não nomes.
   * `limit` existe para a UI não pedir 1.033 linhas por acidente.
   */
  app.get<{ Querystring: { entityType?: string; state?: string; limit?: string } }>(
    '/mappings',
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
  app.get<{ Querystring: { curriculumId?: string } }>('/pendencias/year-groups', async (req, reply) => {
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
  });

  return app;
}
