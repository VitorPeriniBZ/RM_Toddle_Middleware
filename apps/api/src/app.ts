import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { configVersion, configVersionDetalhe, env, logger, tenantConfig } from '@rm-toddle/config';
import { pgPool, idMappingRepository, ENTITY_TYPES, type EntityType } from '@rm-toddle/db';
import { toddleClient } from '@rm-toddle/integrations';
import { autenticar } from './auth';
import { exigirPapel } from './autorizacao';
import { registrarRotasDeSessao } from './rotas/sessao';
import { registrarRotasDeAgenda } from './rotas/agenda';
import { registrarRotasDeJobs } from './rotas/jobs';
import { registrarRotasDeVinculos } from './rotas/vinculos';
import { registrarRotasDeAcessos } from './rotas/acessos';
import { registrarRotasDeSentencas } from './rotas/sentencas';

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
type EstadoDependencia = 'ok' | 'limitado' | 'falha';

interface Dependencia {
  nome: string;
  ok: boolean;
  estado: EstadoDependencia;
  erro?: string;
  /** Segundos até a janela liberar, quando a API informa. */
  liberaEmSegundos?: number;
}

async function checarDependencia(
  nome: string,
  fn: () => Promise<unknown>,
): Promise<Dependencia> {
  try {
    await fn();
    return { nome, ok: true, estado: 'ok' };
  } catch (e) {
    const status = (e as { status?: number }).status;
    const texto = e instanceof Error ? e.message : String(e);
    const corpo = JSON.stringify((e as { body?: unknown }).body ?? '');

    // 429, ou a mensagem do Toddle quando o status não veio.
    if (status === 429 || /rate limit/i.test(corpo + texto)) {
      const seg = Number(/after (\d+) seconds/i.exec(corpo + texto)?.[1] ?? 300);
      return {
        nome,
        ok: false,
        estado: 'limitado',
        erro: `limite de requisições atingido — não é queda. A janela do Toddle é de ${seg}s`,
        liberaEmSegundos: seg,
      };
    }
    return { nome, ok: false, estado: 'falha', erro: texto.slice(0, 160) };
  }
}

/**
 * O check do Toddle, com cache curto.
 *
 * Guardado em módulo e não em Redis de propósito: é vivacidade do PROCESSO, e
 * um cache compartilhado faria uma instância responder pela saúde de outra.
 */
let cacheDoToddle: { em: number; resultado: Dependencia } | null = null;
const VALIDADE_DO_CACHE_MS = 30_000;

async function checarToddleComCache(): Promise<Dependencia> {
  if (cacheDoToddle && Date.now() - cacheDoToddle.em < VALIDADE_DO_CACHE_MS) {
    return cacheDoToddle.resultado;
  }
  const resultado = await checarDependencia('toddle', () => toddleClient.assertTargetOrganization());
  cacheDoToddle = { em: Date.now(), resultado };
  return resultado;
}

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
  // O cookie de sessão precisa ser lido em toda requisição (`autenticar`) e
  // escrito no login. Registrado ANTES do hook de autenticação.
  void app.register(cookie);

  void app.register(cors, {
    origin: origensPermitidas,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    // Sem isto o navegador NÃO manda o cookie de sessão numa origem diferente
    // (a UI do Vite roda na 5173). Só vale com allowlist — e é por isso que
    // `origin` acima nunca pode virar "*": as duas coisas juntas seriam um
    // convite para qualquer site usar a sessão de quem estiver logado.
    credentials: true,
  });

  /*
   * ─── CSRF: CHECAGEM DE ORIGEM NOS MÉTODOS QUE MUDAM ESTADO ───────────────
   *
   * Enquanto a autenticação era um header `Authorization`, CSRF não existia: o
   * navegador não anexa header sozinho. Com a sessão em COOKIE ele anexa, e
   * qualquer página aberta no navegador de quem está logado poderia disparar um
   * POST para cá.
   *
   * `SameSite=lax` cobre o caso comum e tem buracos reais: subdomínio conta como
   * "same-site", e cliente antigo pode ignorar o atributo.
   *
   * `Sec-Fetch-Site` é preenchido pelo NAVEGADOR e não pode ser forjado por
   * página web — `same-site` é recusado de propósito: subdomínio não é esta
   * aplicação.
   *
   * O que isto NÃO é: defesa contra cookie roubado. Um `curl` escolhe os headers
   * que quiser. Contra isso serve a revogação de sessão.
   */
  app.addHook('onRequest', async (req, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;

    // ─── BEARER NÃO PRECISA DESTA CHECAGEM ───────────────────────────────
    //
    // CSRF existe porque o navegador anexa o COOKIE sozinho. Ele nunca anexa um
    // header `Authorization` sozinho — quem o manda teve de escrevê-lo. Então
    // requisição que se autentica por Bearer e NÃO traz cookie de sessão não é
    // um alvo possível, e exigir Origin dela só quebraria script e CI.
    const temCookie = Boolean(req.cookies?.[env.COOKIE_NOME]);
    if (!temCookie && req.headers.authorization?.startsWith('Bearer ')) return;

    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite === 'same-origin' || fetchSite === 'none') return;

    const origem = req.headers.origin;
    if (origem && origensPermitidas.includes(origem)) return;

    if (fetchSite) {
      logger.warn({ rota: req.url, fetchSite, origem }, 'CSRF: origem recusada');
      return reply.code(403).send({ erro: 'csrf', detalhe: 'origem não autorizada para esta operação' });
    }

    // Sem Sec-Fetch-*: compara o host do Origin/Referer com o nosso. Ausência
    // dos dois é RECUSA — deixar passar aqui abriria exatamente o desvio que
    // esta checagem existe para fechar.
    const referer = req.headers.referer;
    const bruto = origem ?? referer;
    if (!bruto) {
      return reply.code(403).send({ erro: 'csrf', detalhe: 'requisição sem Origin nem Referer' });
    }
    try {
      if (new URL(bruto).host !== req.headers.host) {
        return reply.code(403).send({ erro: 'csrf', detalhe: 'host de origem diferente' });
      }
    } catch {
      return reply.code(403).send({ erro: 'csrf', detalhe: 'Origin/Referer ilegível' });
    }
    return undefined;
  });

  // Autentica tudo, exceto o health check — que precisa responder para o
  // orquestrador mesmo quando a autenticação está mal configurada — e a criação
  // de sessão, que é onde a autenticação COMEÇA (ela valida o token do Google
  // por conta própria).
  app.addHook('onRequest', async (req, reply) => {
    const publicas = ['/health', '/auth/config', '/auth/sessao', '/auth/sair'];
    // `/auth/sair` é pública de propósito: ela lê o cookie por conta própria e
    // revoga por ele, porque sair da conta não pode falhar por falta de sessão.
    if (publicas.some((r) => req.url === r || req.url.startsWith(r + '?'))) return;
    await autenticar(req, reply);
  });

  /**
   * Vivacidade + dependências. Sem autenticação, sem PII.
   *
   * ─── RATE LIMIT NÃO É QUEDA ─────────────────────────────────────────────
   *
   * O Toddle pune excesso com `429` e uma janela de 300s. Até 11/09/2026 esta
   * rota tratava isso como falha, e a tela dizia "1 FORA DO AR" — diagnóstico
   * errado: o Toddle estava de pé, nós é que pedimos demais. Quem lesse aquilo
   * iria procurar defeito no lugar errado.
   *
   * `limitado` é um terceiro estado, e a tela o pinta como atenção, não erro.
   *
   * ─── O CHECK NÃO PODE SER A CAUSA DO PROBLEMA QUE ELE RELATA ────────────
   *
   * `assertTargetOrganization` é uma chamada REAL ao Toddle, e o orçamento é
   * limitado. Sem cache, cada visita à aba Saúde gastava uma requisição da
   * mesma janela que os syncs precisam — um verificador que ajuda a estourar o
   * limite que ele mede. O resultado fica em cache por 30s; para vivacidade
   * isso é tempo real de sobra.
   */
  app.get('/health', async () => {
    const deps = await Promise.all([
      checarDependencia('postgres', () => pgPool.query('SELECT 1')),
      checarToddleComCache(),
    ]);
    return {
      // Limitado NÃO derruba o `ok`: o serviço está no ar, e um monitor externo
      // não deve ser paginado porque alguém abriu a tela duas vezes seguidas.
      ok: deps.every((d) => d.ok || d.estado === 'limitado'),
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
  void app.register(registrarRotasDeSessao);
  void app.register(registrarRotasDeAgenda);
  void app.register(registrarRotasDeJobs);
  void app.register(registrarRotasDeVinculos);
  void app.register(registrarRotasDeAcessos);
  void app.register(registrarRotasDeSentencas);

  return app;
}
