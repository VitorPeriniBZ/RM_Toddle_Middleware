import { env } from './env';

/**
 * A configuração de UMA escola (tenant) — o que muda de cliente para cliente.
 *
 * ─── POR QUE ESTA CAMADA EXISTE ─────────────────────────────────────────────
 *
 * O objetivo do produto é white label: uma página onde se configura "este TOTVS"
 * para "aquele Toddle". Hoje toda configuração de escola vem de variável de
 * ambiente, então **um deploy = uma escola** — o próprio `env.ts` chama isso de
 * "limitação consciente da v1".
 *
 * Esta camada é a costura para sair dessa limitação, e ela vem ANTES de escrever
 * fluxo novo. O motivo é aritmético: cada fluxo escrito lendo `env` direto é um
 * fluxo para refatorar depois. Faltam quatro (turma automática, plano de aula,
 * frequência de volta, nota de volta); adiar a costura é aceitar refatorar quatro
 * vezes em vez de uma.
 *
 * ─── A LINHA QUE SEPARA O QUE ENTRA E O QUE FICA NO AMBIENTE ────────────────
 *
 * ENTRA (varia por escola): credencial e URL do RM, coligada, campus, período
 * letivo, códigos das Sentenças, token e organização do Toddle, prefixo de
 * sourceId, regras de escopo.
 *
 * NÃO ENTRA (varia por DEPLOY, não por escola): `DATABASE_URL`, `REDIS_URL`,
 * `LOG_LEVEL`, `NODE_ENV`, as variáveis da API e do Google, `SYNC_BATCH_SIZE`,
 * os crons, `SYNC_DESVIO_MAX_PCT` e as URLs de heartbeat. São decisões de
 * operação da instância, não da escola — e a conclusão de arquitetura é
 * **deploy por tenant** (raio de dano isolado, e história de LGPD muito mais
 * simples com dado de menor de idade), então o processo continua sendo de um
 * ambiente só.
 *
 * ─── O QUE ESTE ARQUIVO DELIBERADAMENTE NÃO FAZ ─────────────────────────────
 *
 * Não lê do banco. `resolveTenantConfig` monta a config a partir do ambiente e
 * é o único lugar que precisa mudar quando a origem virar a tabela
 * `integration_connection` (que já existe no schema, com `secret_ref` reservado
 * exatamente para isto). Mover segredo para o banco ANTES de haver segunda
 * escola assumiria risco de cifra e rotação sem comprar desacoplamento nenhum —
 * o desacoplamento vem da forma de acesso, que é este módulo, não do storage.
 */

/** Como alcançar o wsConsultaSQL / wsDataServer do RM. */
export interface RmConexao {
  baseUrl?: string;
  usuario?: string;
  senha?: string;
  /** Sistema RM das Sentenças educacionais (normalmente "S"). */
  sistema: string;
}

/** O recorte de dados que esta escola autoriza. */
export interface RmEscopo {
  coligada: number;
  /** CSV de CODFILIAL, ou o literal "ALL". Nunca vazio — ver env.ts. */
  filiais: string;
  periodoLetivo?: string;
  /** CSV de códigos de status considerados ativos. Vazio = aceita todos. */
  statusAtivos: string;
  /** Regex aplicada ao COD_TURMA: turma que não deve virar turma no Toddle. */
  turmasIgnoradas?: string;
}

/** Códigos das Sentenças cadastradas NO RM desta escola. */
export interface RmSentencas {
  alunos?: string;
  turmaDisc?: string;
  responsaveis?: string;
  frequencia?: string;
  notas?: string;
}

export interface ToddleConexao {
  baseUrl: string;
  token: string;
  /** Organização de destino. Travessa de segurança: o cliente aborta se divergir. */
  organizationId: string;
  pageSize: number;
  yearGroupPadrao?: string;
}

export interface TenantConfig {
  /** Slug da escola. Casa com `tenant.slug` no banco. */
  slug: string;
  rm: {
    conexao: RmConexao;
    escopo: RmEscopo;
    sentencas: RmSentencas;
  };
  toddle: ToddleConexao;
  /**
   * Prefixo do sourceId enviado ao Toddle. Escolha um formato e NUNCA mude — é
   * ele que sustenta o upsert idempotente.
   */
  sourceIdPrefix: string;
}

/**
 * Monta a config da escola a partir do ambiente.
 *
 * É a ÚNICA implementação hoje, e o único ponto a trocar quando a origem virar o
 * banco. A assinatura já aceita o slug para que os chamadores nasçam passando
 * tenant — mesmo que hoje só exista um.
 *
 * Recusa slug desconhecido em vez de devolver a config do tenant do ambiente:
 * devolver a config errada escreveria dado de uma escola na organização de outra,
 * que é a pior falha possível neste sistema.
 */
export function resolveTenantConfig(slug: string = env.TENANT_SLUG): TenantConfig {
  if (slug !== env.TENANT_SLUG) {
    throw new Error(
      `Tenant "${slug}" não está configurado neste processo (que atende "${env.TENANT_SLUG}"). ` +
        'Enquanto a config vem do ambiente, um deploy atende uma escola. ' +
        'Para atender outra, suba outro deploy ou implemente a leitura de integration_connection.',
    );
  }

  return {
    slug: env.TENANT_SLUG,
    rm: {
      conexao: {
        baseUrl: env.RM_WS_BASEURL,
        usuario: env.RM_WS_USER,
        senha: env.RM_WS_PASS,
        sistema: env.RM_WS_SISTEMA,
      },
      escopo: {
        coligada: env.RM_CODCOLIGADA,
        filiais: env.RM_CODFILIAL,
        periodoLetivo: env.RM_CODPERLET,
        statusAtivos: env.RM_ACTIVE_TERM_STATUSES,
        turmasIgnoradas: env.RM_TURMAS_IGNORADAS,
      },
      sentencas: {
        alunos: env.RM_SENTENCA_STUDENTS,
        turmaDisc: env.RM_SENTENCA_TURMADISC,
        responsaveis: env.RM_SENTENCA_RESPONSAVEIS,
        frequencia: env.RM_SENTENCA_FREQUENCIA,
        notas: env.RM_SENTENCA_NOTAS,
      },
    },
    toddle: {
      baseUrl: env.TODDLE_BASE_URL,
      token: env.TODDLE_TOKEN,
      organizationId: env.TODDLE_ORG_ID,
      pageSize: env.TODDLE_PAGE_SIZE,
      yearGroupPadrao: env.TODDLE_DEFAULT_YEAR_GROUP_ID,
    },
    sourceIdPrefix: env.SOURCE_ID_PREFIX,
  };
}

/**
 * A config do tenant que este processo atende.
 *
 * Existe para os 30+ pontos que hoje leem `env.ALGO` poderem passar a ler
 * `tenantConfig.rm.escopo.algo` sem receber o tenant como parâmetro ainda. É
 * ponte, não destino: código NOVO deve receber `TenantConfig` (ou o slug) como
 * argumento, para nascer multi-tenant.
 */
export const tenantConfig: TenantConfig = resolveTenantConfig();

/** O wsConsultaSQL está configurado nesta config? */
export function rmSoapConfigurado(cfg: TenantConfig = tenantConfig): boolean {
  return Boolean(cfg.rm.conexao.baseUrl && cfg.rm.conexao.usuario && cfg.rm.conexao.senha);
}
