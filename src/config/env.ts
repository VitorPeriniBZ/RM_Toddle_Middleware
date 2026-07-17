import 'dotenv/config';
import { z } from 'zod';

/**
 * Todas as credenciais e parâmetros do middleware vêm de variáveis de
 * ambiente, validadas com Zod na inicialização. O processo NÃO sobe com
 * configuração inválida (fail-fast).
 */
const stringBool = z.enum(['true', 'false']).default('true').transform((v) => v === 'true');

const envSchema = z.object({
  // --- TOTVS RM Educacional (API TTALK: {host}/api/educational/v1) ---
  TOTVS_RM_HOST: z.string().url(),
  /** Valor COMPLETO do header Authorization (o esquema depende do ambiente do RM). */
  TOTVS_RM_AUTH_HEADER: z.string().min(1),
  TOTVS_RM_PAGE_SIZE: z.coerce.number().int().positive().default(200),
  /** CSV de MajorStatus/TermStatus "ativos" — domínios não documentados nos specs. Vazio = aceita todos. */
  RM_ACTIVE_TERM_STATUSES: z.string().default(''),

  // --- Banco do RM (SQL Server) — opcional; sem ele o enriquecimento é pulado ---
  RM_SQL_SERVER: z.string().optional(),
  RM_SQL_PORT: z.coerce.number().int().default(1433),
  RM_SQL_DATABASE: z.string().optional(),
  RM_SQL_USER: z.string().optional(),
  RM_SQL_PASSWORD: z.string().optional(),
  RM_SQL_ENCRYPT: stringBool,
  RM_SQL_TRUST_CERT: stringBool,
  RM_CODCOLIGADA: z.coerce.number().int().default(1),

  // --- Toddle Open API V2 (Toddle 1.0) ---
  TODDLE_REGION: z.string().default('us-east-1'),
  TODDLE_BASE_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  TODDLE_TOKEN: z.string().min(1),
  /** GET /students exige paginação; pageSize documentado entre 100 e 400. */
  TODDLE_PAGE_SIZE: z.coerce.number().int().min(100).max(400).default(400),
  TODDLE_DEFAULT_YEAR_GROUP_ID: z.string().optional(),

  // --- Integração ---
  /** Prefixo do sourceId (ex.: "1-" para coligada). Escolha um formato e NUNCA mude. */
  SOURCE_ID_PREFIX: z.string().default(''),
  SYNC_BATCH_SIZE: z.coerce.number().int().positive().max(200).default(50),
  STUDENTS_SYNC_CRON: z.string().default('0 3 * * *'),

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

/** O enriquecimento via SQL (e o Fluxo 2) só rodam se a conexão do RM estiver configurada. */
export const isRmSqlConfigured = Boolean(
  raw.RM_SQL_SERVER && raw.RM_SQL_DATABASE && raw.RM_SQL_USER && raw.RM_SQL_PASSWORD,
);
