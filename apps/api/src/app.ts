import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import {
  LIMITE_GLOBAL,
  SALTOS_CONFIAVEIS,
  isentaDeLimite,
  limiteParaRota,
} from './limitesDaApi';
import cookie from '@fastify/cookie';
import {
  alertar,
  configVersion,
  configVersionDetalhe,
  diagnosticoDoAmbiente,
  env,
  logger,
  tenantConfig,
} from '@rm-toddle/config';
import { pgPool, idMappingRepository, ENTITY_TYPES, type EntityType } from '@rm-toddle/db';
import { toddleClient } from '@rm-toddle/integrations';
import { autenticar } from './auth';
import { exigirPapel } from './autorizacao';
import {
  assuntoDeDependenciaFora,
  assuntoDeDependenciaVoltou,
  avaliarProntidao,
  comPrazo,
  transicoes,
  type Prontidao,
} from './prontidao';
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

/**
 * O texto que vai para a tela quando algo falha.
 *
 * `erro.message` sozinho não basta: `AggregateError` — que é o que o `pg` e o
 * `ioredis` levantam quando nem IPv4 nem IPv6 conectam — tem `message` VAZIA, e
 * a resposta saía como `{"erro":""}`. Tela em branco sobre um banco fora do ar é
 * o mesmo silêncio que este projeto passa a vida caçando: o erro existiu, foi
 * registrado no log, e quem estava olhando não recebeu nada.
 */
function mensagemDe(erro: Error): string {
  if (erro.message) return erro.message;
  const internos = (erro as unknown as { errors?: Error[] }).errors;
  const primeiro = internos?.find((e) => e?.message)?.message;
  return primeiro ? `${erro.name}: ${primeiro}` : erro.name || 'falha interna';
}

/**
 * ─── A SONDA É PÚBLICA, ENTÃO ELA NÃO PODE SER UMA ALAVANCA ─────────────────
 *
 * `/health/ready` é anônima, e sem esta guarda cada requisição dispara duas
 * checagens reais. Dois problemas, os dois apontados na revisão e confirmados
 * no código:
 *
 *   1. `checarToddleComCache` guarda o resultado (inclusive falha), mas NÃO tem
 *      single-flight: N requisições chegando antes de o cache popular iniciam N
 *      escadas de retry de 5 tentativas cada, contra o Toddle.
 *   2. `pgPool` tem `max: 10` e nenhum `connectionTimeoutMillis`
 *      (packages/db/src/pool.ts). Um `SELECT 1` abandonado pela corrida do
 *      prazo segura um client — e segura exatamente quando o banco já está mal.
 *
 * O cache resolve os dois pelo mesmo mecanismo: no máximo UMA checagem em voo,
 * por mais que batam aqui. Cinco segundos é curto o bastante para um monitor de
 * 30s nunca ver dado velho, e longo o bastante para uma enxurrada não virar
 * carga.
 *
 * O que isto NÃO é: rate limit. Um limitador de verdade é o P1-5, e precisa
 * resolver o `trustProxy` antes (docs/TODO.md §4.3). Isto é a guarda mínima
 * para que a rota introduzida agora não seja pior que a ausência dela.
 */
let cacheDaProntidao: { em: number; resultado: Prontidao } | null = null;
let prontidaoEmVoo: Promise<Prontidao> | null = null;
const VALIDADE_DA_PRONTIDAO_MS = 5_000;

/** Último estado conhecido por dependência. Alimenta o aviso de recuperação. */
const estadoAnterior = new Map<string, 'fora' | 'ok'>();

async function checarProntidao(): Promise<Prontidao> {
  /*
   * Cada checagem corre contra um prazo — ver `PRAZO_DA_CHECAGEM_MS`. Sem isto
   * a rota levava 26s com o Toddle fora (medido), e monitor nenhum espera
   * tanto: ele reportaria TIMEOUT em vez do 503 que diz QUAL dependência caiu.
   */
  const deps = await Promise.all([
    comPrazo('postgres', () => checarDependencia('postgres', () => pgPool.query('SELECT 1'))),
    comPrazo('toddle', () => checarToddleComCache()),
  ]);

  const prontidao = avaliarProntidao(deps);

  /*
   * ─── ALERTA POR TRANSIÇÃO, E POR DEPENDÊNCIA ─────────────────────────────
   *
   * O vigia (no worker) cobre fila, DLQ e runs. Ele NÃO cobre "a API não
   * alcança o Postgres" — outro processo, outra rede, outro pool.
   *
   * POR DEPENDÊNCIA, não pelo conjunto: um assunto que carregue o conjunto
   * inteiro tem 2^N−1 valores possíveis, e um Toddle intermitente com o
   * Postgres fora dobraria as notificações porque o conjunto alterna.
   *
   * POR TRANSIÇÃO, e não a cada checagem: só o que MUDOU vira alerta. É o que
   * permite o aviso de volta — sem ele o operador acorda às 02:00, abre o
   * laptop às 02:05, encontra tudo verde e não sabe se consertou sozinho.
   *
   * 30 minutos de janela: mais curto que as 6h do vigia porque o plano de
   * controle sem banco é mais urgente, e longo o bastante para uma sonda de 30s
   * não virar 120 notificações por hora.
   *
   * `limitado` nunca vira alerta: conta como ok em `transicoes`, pela mesma
   * razão que não derruba o 503.
   */
  for (const t of transicoes(estadoAnterior, deps)) {
    const fora = t.para === 'fora';
    void alertar({
      assunto: fora ? assuntoDeDependenciaFora(t.nome) : assuntoDeDependenciaVoltou(t.nome),
      contexto: {
        componente: 'api',
        dependencia: t.nome,
        significado: fora
          ? 'a API está no ar mas não consegue trabalhar'
          : 'voltou a responder; o incidente anterior desta dependência está encerrado',
        degradadas: prontidao.degradadas.length > 0 ? prontidao.degradadas.join(', ') : undefined,
      },
      repetirApos: 30 * 60 * 1_000,
    });
  }
  for (const d of deps) estadoAnterior.set(d.nome, d.estado === 'falha' ? 'fora' : 'ok');

  return prontidao;
}

/** Uma checagem em voo por vez, e resultado válido por alguns segundos. */
async function prontidaoComCache(): Promise<Prontidao> {
  const agora = Date.now();
  if (cacheDaProntidao && agora - cacheDaProntidao.em < VALIDADE_DA_PRONTIDAO_MS) {
    return cacheDaProntidao.resultado;
  }
  // Single-flight: quem chega durante uma checagem espera a MESMA, não abre outra.
  prontidaoEmVoo ??= checarProntidao()
    .then((r) => {
      cacheDaProntidao = { em: Date.now(), resultado: r };
      return r;
    })
    .finally(() => {
      prontidaoEmVoo = null;
    });
  return prontidaoEmVoo;
}

export function construirApp() {
  const app = Fastify({
    loggerInstance: logger,
    /*
     * ─── UM SALTO, E NUNCA `true` ──────────────────────────────────────────
     *
     * `true` faria o `req.ip` sair da entrada MAIS À ESQUERDA do
     * `X-Forwarded-For` — que é controlada por quem chama, porque os dois
     * proxies da frente ANEXAM em vez de substituir. Ver o cabeçalho de
     * `limitesDaApi.ts`: com `true`, forjar o XFF de outra pessoa esgotaria a
     * cota DELA.
     *
     * `1` confia só no nginx, o único par direto desta API e o único salto que
     * este repositório controla. Faz `X-Forwarded-Proto` funcionar (sem ele a
     * API se vê como `http`) e deixa o `req.ip` constante e não forjável.
     */
    trustProxy: SALTOS_CONFIAVEIS,
  });

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

  /*
   * `helmet` com os defaults, e uma exceção deliberada: `contentSecurityPolicy`
   * fica DESLIGADA aqui porque esta aplicação **não serve HTML** — ela é só
   * JSON, e quem serve a tela é o nginx do `web`. Uma CSP numa API JSON não
   * protege nada e só produz header morto; a CSP que importa é a do `web`, e
   * ela é item próprio.
   *
   * O resto entra: `nosniff`, `frameguard`, `hsts`, `referrerPolicy`. Nenhum
   * deles conflita com o CORS por allowlist nem com o cookie de sessão — e a
   * allowlist NÃO pode regredir, é o que impede qualquer site de usar a sessão
   * de quem está logado.
   */
  void app.register(helmet, {
    contentSecurityPolicy: false,
    /*
     * ─── CORP DESLIGADA, E ISTO NÃO É AFROUXAR ────────────────────────────
     *
     * O default do helmet é `cross-origin-resource-policy: same-origin`, e ele
     * quebraria o desenvolvimento: a UI roda no Vite, em `localhost:5173`, e a
     * API em `3333` — origens DIFERENTES. Em produção as duas são a mesma
     * origem (o nginx serve `/api` no mesmo domínio), então o header não
     * protegeria nada lá e só derrubaria o fluxo aqui.
     *
     * Quem controla quem pode ler esta API é o CORS por allowlist, logo
     * abaixo, com `credentials: true`. Essa allowlist é a proteção e NÃO pode
     * regredir — CORP seria uma segunda tranca na porta errada.
     */
    crossOriginResourcePolicy: false,
  });

  /*
   * ─── O LIMITADOR, E POR QUE O BALDE É ÚNICO ───────────────────────────────
   *
   * `keyGenerator` devolve uma constante de propósito. O `req.ip`, mesmo com
   * `trustProxy: 1`, é o IP do proxy interno — igual para todo mundo. Deixar o
   * default (que usa `req.ip`) daria o mesmo resultado por acidente; escrever a
   * constante deixa a decisão VISÍVEL, e é ela que impede alguém de "melhorar"
   * para `req.ip` achando que isso separa clientes. Não separa, e no dia em que
   * o XFF for confiado separaria errado.
   *
   * O teto por rota vem de `limitesDaApi.ts`, aplicado no `onRoute` abaixo.
   */
  void app.register(rateLimit, {
    global: true,
    max: LIMITE_GLOBAL.max,
    timeWindow: LIMITE_GLOBAL.timeWindow,
    keyGenerator: () => 'global',
    // O corpo do 429 diz o que fazer, não só que falhou.
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message:
        `Limite de ${ctx.max} chamadas por janela atingido. Tente de novo em ` +
        `${Math.ceil(ctx.ttl / 1000)}s. Este limite é GLOBAL, não por usuário — ` +
        'ver docs/RUNBOOK.md §4.1.',
    }),
  });

  /*
   * Teto próprio por rota, decidido em UM lugar.
   *
   * Via `onRoute` e não espalhado pelos arquivos de rota: política de limite
   * que mora junto de cada handler é política que diverge — e aqui ela precisa
   * ser lida inteira para fazer sentido (qual rota custa o quê).
   */
  app.addHook('onRoute', (opcoes) => {
    const metodos = Array.isArray(opcoes.method) ? opcoes.method : [opcoes.method];
    if (isentaDeLimite(opcoes.url)) {
      opcoes.config = { ...opcoes.config, rateLimit: false };
      return;
    }
    for (const metodo of metodos) {
      const limite = limiteParaRota(metodo, opcoes.url);
      if (limite) {
        opcoes.config = { ...opcoes.config, rateLimit: limite };
        return;
      }
    }
  });

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
    // `/health/ready` entra explicitamente: a comparação abaixo é por igualdade
    // (ou com querystring), não por prefixo — `/health` NÃO cobre `/health/ready`,
    // e sem esta linha a rota de prontidão exigiria sessão. Um monitor externo
    // não tem sessão, e o sintoma seria um 401 lido como "a API caiu".
    const publicas = ['/health', '/health/ready', '/auth/config', '/auth/sessao', '/auth/sair'];
    // `/auth/sair` é pública de propósito: ela lê o cookie por conta própria e
    // revoga por ele, porque sair da conta não pode falhar por falta de sessão.
    if (publicas.some((r) => req.url === r || req.url.startsWith(r + '?'))) return;
    await autenticar(req, reply);
  });

  /*
   * ─── QUEM ESCOLHE O STATUS DESTA API É ESTA API ──────────────────────────
   *
   * Sem este handler, o Fastify usa `err.statusCode` OU `err.status` do erro
   * que subir. `status` é campo do `AxiosError` — então um 401 do RM virava um
   * 401 NOSSO, e a tela, que só conhece um significado para 401 ("sessão
   * morta"), mandava o operador para o login. Em 21/09/2026 isso produziu seis
   * logins em treze minutos, com a sessão viva o tempo todo, enquanto o RM
   * recusava a própria credencial numa janela que passou sozinha às 09:15.
   *
   * O `wsDataServerClient` já não deixa mais `AxiosError` escapar; isto aqui é
   * a rede embaixo — vale para o Toddle, para qualquer cliente HTTP novo e para
   * o próximo `axios.get` que alguém escrever sem `try/catch`.
   *
   * ─── POR QUE 502, E NÃO 500 ──────────────────────────────────────────────
   *
   * "Falhei" e "o sistema de quem eu dependo falhou" são diagnósticos
   * diferentes, e quem lê a tela precisa dessa diferença: 502 com a mensagem do
   * RM manda olhar o RM. O que NUNCA pode sair daqui por causa de terceiro é
   * 401 — esse código, nesta aplicação, significa uma coisa só.
   */
  app.setErrorHandler((erroCru, req, reply) => {
    const erro = erroCru as Error & {
      statusCode?: number;
      status?: number;
      isAxiosError?: boolean;
      validation?: unknown;
    };

    logger.error({ err: erro, rota: req.url, metodo: req.method }, 'requisição falhou');

    // Corpo malformado é culpa de quem chamou, e o Fastify já diz o que falta.
    if (erro.validation) return reply.code(400).send({ erro: mensagemDe(erro) });

    /*
     * `statusCode` é a convenção do Fastify e dos nossos próprios erros; é o
     * único campo em que confiamos para repetir um status. `status` fica de
     * fora DE PROPÓSITO: é ele que o axios preenche, e foi ele que causou o
     * laço de login.
     */
    const nosso = erro.isAxiosError === true ? undefined : erro.statusCode;
    if (typeof nosso === 'number' && nosso >= 400 && nosso < 600) {
      return reply.code(nosso).send({ erro: mensagemDe(erro) });
    }

    const deTerceiro = erro.isAxiosError === true || erro.name === 'RmDataServerError';
    return reply.code(deTerceiro ? 502 : 500).send({ erro: mensagemDe(erro) });
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
    /*
     * ─── UM BIT SÓ, E ESTA ROTA É PÚBLICA ────────────────────────────────
     *
     * Um sistema sem canal de alerta não está "saudável com uma configuração
     * faltando": está incapaz de pedir socorro, e isso pertence à saúde.
     *
     * Mas aqui sai SÓ o booleano. A primeira versão publicava também quais
     * variáveis faltam e o estado de cada heartbeat — para um chamador
     * ANÔNIMO, isso é a postura operacional da escola, e uma vez exposta não
     * se recolhe: fica em cache, em índice, no histórico de quem coletou. O
     * detalhe mudou para `/config`, que exige papel `viewer`.
     *
     * Conferido antes de reduzir: o frontend só consome `ok` e `dependencias`
     * (apps/web/src/api.ts:264), e o healthcheck do Coolify nem lê o corpo
     * (`wget -qO- ... || exit 1`). Ninguém quebra.
     *
     * NÃO derruba o `ok`: transformar falta de webhook em container
     * `unhealthy` faria o Coolify reiniciar em laço uma instalação que está
     * funcionando. É informação, não falha.
     */
    return {
      // Limitado NÃO derruba o `ok`: o serviço está no ar, e um monitor externo
      // não deve ser paginado porque alguém abriu a tela duas vezes seguidas.
      ok: deps.every((d) => d.ok || d.estado === 'limitado'),
      authMode: env.API_AUTH_MODE,
      tenant: cfg.slug,
      configVersion: configVersion(),
      dependencias: deps,
      /** `true` = uma falha deste sistema não avisa ninguém. Detalhe em /config. */
      cegoParaAlertas: diagnosticoDoAmbiente().cego,
    };
  });

  /**
   * PRONTIDÃO — "ele consegue trabalhar agora?". Ver apps/api/src/prontidao.ts
   * para por que esta rota existe separada do `/health`, e por que o `/health`
   * continua sempre 200.
   *
   * Pública, como o `/health`, e com corpo mínimo: nome e estado, nunca o texto
   * do erro. Um monitor externo aponta para cá; o Coolify continua no `/health`.
   */
  app.get('/health/ready', async (_req, reply) => {
    const prontidao = await prontidaoComCache();
    return reply.code(prontidao.status).send({
      pronto: prontidao.pronto,
      dependencias: prontidao.dependencias,
    });
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

  /**
   * Configuração de escopo/destino em vigor. Nenhum segredo é exposto.
   *
   * O detalhe do canal de aviso mora AQUI e não no `/health` porque exige papel
   * `viewer`: quais monitores faltam é postura operacional, e `/health` é
   * público. O `/health` publica só o booleano `cegoParaAlertas`.
   *
   * Continuam saindo apenas ESTADOS e NOMES de variável — nunca as URLs.
   */
  app.get('/config', { preHandler: exigirPapel(['viewer']) }, async () => {
    const avisos = diagnosticoDoAmbiente();
    return {
      ...configVersionDetalhe(),
      avisos: {
        alerta: avisos.alerta,
        heartbeats: avisos.heartbeats,
        cego: avisos.cego,
        faltando: avisos.faltando,
        resumo: avisos.resumo,
      },
    };
  });

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
