import 'dotenv/config';
import { z } from 'zod';

/**
 * Todas as credenciais e parâmetros do middleware vêm de variáveis de
 * ambiente, validadas com Zod na inicialização. O processo NÃO sobe com
 * configuração inválida (fail-fast).
 */
const stringBool = z.enum(['true', 'false']).default('true').transform((v) => v === 'true');

const envSchema = z.object({
  // --- TOTVS RM Educacional (API TTALK REST) — OPCIONAL ---
  // No CloudTOTVS o REST educacional em geral NÃO está publicado; a fonte de
  // dados do RM é o wsConsultaSQL (SOAP) abaixo. Deixe vazio se não houver REST.
  TOTVS_RM_HOST: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  TOTVS_RM_AUTH_HEADER: z.string().optional(),
  TOTVS_RM_PAGE_SIZE: z.coerce.number().int().positive().default(200),
  /** CSV de MajorStatus/TermStatus "ativos" — domínios não documentados nos specs. Vazio = aceita todos. */
  RM_ACTIVE_TERM_STATUSES: z.string().default(''),

  // --- TBC / wsConsultaSQL (SOAP) — fonte de dados do RM ---
  RM_WS_BASEURL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  RM_WS_USER: z.string().optional(),
  RM_WS_PASS: z.string().optional(),
  /** Sistema RM das Sentenças educacionais (normalmente "S"). */
  RM_WS_SISTEMA: z.string().default('S'),
  /** Código da Sentença que devolve o roster de alunos (obrigatória p/ o Fluxo 1 via SOAP). */
  RM_SENTENCA_STUDENTS: z.string().optional(),
  /** Período letivo passado à Sentença de alunos (ex.: "2026"). */
  RM_CODPERLET: z.string().optional(),
  /** Sentenças do Fluxo 2 (roadmap). */
  RM_SENTENCA_FREQUENCIA: z.string().optional(),
  RM_SENTENCA_NOTAS: z.string().optional(),
  RM_CODCOLIGADA: z.coerce.number().int().default(1),
  /**
   * Campus (CODFILIAL) no escopo da integração, em CSV. OBRIGATÓRIA.
   *
   * Nesta escola: 1 = Infantil + Fundamental I; 2 = campus do aeroporto
   * (Fundamental II + Médio). Só o 2 está no escopo do Toddle.
   *
   * NÃO tem default. Vazio antes significava "todos os campi", e em 31/07/2026
   * isso sincronizou 586 alunos em vez de 253 — o campus 1 inteiro foi criado no
   * Toddle e depois teve de ser arquivado um a um. Configuração ausente não pode
   * AMPLIAR escopo de dados de alunos; tem que abortar. Para incluir todos os
   * campi de propósito, declare o literal "ALL".
   */
  RM_CODFILIAL: z
    .string()
    .min(1, 'RM_CODFILIAL é obrigatória: liste os CODFILIAL em escopo (ex.: "2") ou "ALL" para todos'),

  // --- Banco do RM (SQL Server) — legado/opcional; só o Fluxo 2 escrita usaria ---
  RM_SQL_SERVER: z.string().optional(),
  RM_SQL_PORT: z.coerce.number().int().default(1433),
  RM_SQL_DATABASE: z.string().optional(),
  RM_SQL_USER: z.string().optional(),
  RM_SQL_PASSWORD: z.string().optional(),
  RM_SQL_ENCRYPT: stringBool,
  RM_SQL_TRUST_CERT: stringBool,

  // --- Toddle Open API V2 (Toddle 2.0 — modelo TeacherCourse, usado pela EAV) ---
  TODDLE_REGION: z.string().default('us-east-1'),
  TODDLE_BASE_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  TODDLE_TOKEN: z.string().min(1),
  /**
   * Organização Toddle que este processo tem permissão de escrever. OBRIGATÓRIA.
   *
   * É a `target_instance_key` da id_mapping: um mesmo RA pode ter mapeamento no
   * sandbox e na organização final sem colidir. Serve de travessa de segurança —
   * o cliente compara isto com a organização que a API devolve e ABORTA se
   * divergir. Sem isso, trocar o token aponta o sync para outra organização
   * silenciosamente, reusando ids que não existem lá.
   *
   * Sandbox atual: 404045532130986859 (Escola Americana de Vitória_Sandbox).
   */
  TODDLE_ORG_ID: z
    .string()
    .min(1, 'TODDLE_ORG_ID é obrigatória: declare a organização Toddle de destino'),
  /** GET /students exige paginação; pageSize documentado entre 100 e 400. */
  TODDLE_PAGE_SIZE: z.coerce.number().int().min(100).max(400).default(400),
  TODDLE_DEFAULT_YEAR_GROUP_ID: z.string().optional(),

  // --- Integração ---
  /** Prefixo do sourceId (ex.: "1-" para coligada). Escolha um formato e NUNCA mude. */
  SOURCE_ID_PREFIX: z.string().default(''),
  SYNC_BATCH_SIZE: z.coerce.number().int().positive().max(200).default(50),
  STUDENTS_SYNC_CRON: z.string().default('0 3 * * *'),

  // --- Multi-tenant ---
  /**
   * Escola (tenant) que este processo atende. OBRIGATÓRIA.
   *
   * O middleware é white label: a mesma base atende N escolas, e cada linha da
   * id_mapping pertence a uma. Sem tenant declarado uma consulta poderia
   * devolver mapeamento de outra escola — por isso não há default. Enquanto o
   * worker roda por deploy, isto vem do .env; quando a API existir, o tenant
   * será resolvido por requisição/job e esta variável passa a ser só o padrão
   * dos comandos de linha.
   */
  TENANT_SLUG: z
    .string()
    .min(1, 'TENANT_SLUG é obrigatória: informe o slug da escola (ex.: "eav")'),

  // --- Infra do middleware ---
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.string().default('development'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Logger ainda não existe neste ponto do bootstrap
  // eslint-disable-next-line no-console
  console.error(
    'Variáveis de ambiente inválidas:\n',
    JSON.stringify(parsed.error.flatten().fieldErrors, null, 2),
  );
  process.exit(1);
}

const raw = parsed.data;

export const env = {
  ...raw,
  /** Base URL do Toddle: explícita ou montada pela região. */
  TODDLE_BASE_URL: raw.TODDLE_BASE_URL ?? `https://${raw.TODDLE_REGION}-production-apis.toddleapp.com`,
};

/** Fonte de dados do RM via SOAP (wsConsultaSQL) — usada no Fluxo 1. */
export const isRmSoapConfigured = Boolean(
  raw.RM_WS_BASEURL && raw.RM_WS_USER && raw.RM_WS_PASS,
);

/** Acesso direto ao banco (mssql) — legado; só o Fluxo 2 escrita usaria. */
export const isRmSqlConfigured = Boolean(
  raw.RM_SQL_SERVER && raw.RM_SQL_DATABASE && raw.RM_SQL_USER && raw.RM_SQL_PASSWORD,
);
