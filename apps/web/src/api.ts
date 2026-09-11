/**
 * Único ponto de contato da UI com o mundo externo.
 *
 * A UI NUNCA fala com RM, Toddle, Redis ou Postgres — só com esta API. Não é
 * preferência de estilo: se a interface pudesse chamar os sistemas direto, toda
 * validação de "o que pode ser escrito" viraria decoração, porque bastaria um
 * `curl` para contorná-la. A regra vive no servidor.
 */
/**
 * Em DEV o Vite serve na 5173 e a API na 3333 — origens diferentes, daí o CORS
 * por allowlist do lado da API.
 *
 * Em PRODUÇÃO o nginx serve esta UI e faz proxy de `/api` para a API no mesmo
 * domínio. Duas razões para caminho relativo em vez de URL absoluta: a origem
 * passa a ser a mesma (CORS deixa de existir no caminho UI -> API), e o domínio
 * não fica gravado no bundle — o mesmo build serve homologação e produção.
 *
 * `import.meta.env.DEV` é embutido do Vite, não variável de ambiente: não exige
 * afrouxar o `envPrefix`, que é justamente o que o vite.config.ts evita para não
 * varrer TODDLE_TOKEN e RM_WS_PASS para dentro do bundle.
 */
const BASE = import.meta.env.DEV ? 'http://127.0.0.1:3333' : '/api';

export interface AuthConfig {
  authMode: 'google-oidc' | 'localhost';
  clientId: string | null;
}

/** Token do Google em memória. Deliberadamente NÃO em localStorage: ver App.tsx. */
let idToken: string | null = null;
export function setIdToken(t: string | null): void { idToken = t; }
export function getIdToken(): string | null { return idToken; }

export class ApiError extends Error {
  constructor(readonly status: number, readonly corpo: unknown, mensagem: string) {
    super(mensagem);
  }
}

async function pedir<T>(rota: string, metodo = 'GET', corpoEnviado?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  if (corpoEnviado !== undefined) headers['Content-Type'] = 'application/json';

  const r = await fetch(BASE + rota, {
    method: metodo,
    headers,
    body: corpoEnviado === undefined ? undefined : JSON.stringify(corpoEnviado),
  });
  const texto = await r.text();
  const corpo = texto ? JSON.parse(texto) : null;

  if (!r.ok) {
    const msg = (corpo as { erro?: string })?.erro ?? `HTTP ${r.status}`;
    throw new ApiError(r.status, corpo, msg);
  }
  return corpo as T;
}

// ─── Formas que a tela lê do servidor ───────────────────────────────────────
//
// Escritas à mão, e não geradas: a API é o contrato, e um tipo escrito à mão que
// discorda dela aparece como erro de tipo na primeira mudança. Tipo gerado de um
// schema que não existe seria só uma cópia com aparência de garantia.

export interface AgendaDoFluxo {
  flowKey: string;
  cron: string;
  timezone: string;
  ativo: boolean;
  revisao: number;
  revisaoAplicada: number | null;
  aplicadaEm: string | null;
  erroAoAplicar: string | null;
  atualizadoPor: string | null;
  atualizadoEm: string;
}

export interface SchedulerObservado {
  id: string;
  fila: string;
  cron: string | null;
  tz: string | null;
  proximoDisparoEm: string | null;
  iteracoes: number | null;
  desconhecido: boolean;
}

export interface RunResumo {
  tipo: string;
  chave: string;
  estado: 'executing' | 'succeeded' | 'failed';
  resultado: Record<string, unknown>;
  configVersion: string | null;
  criadoEm: string;
  atualizadoEm: string;
}

export interface FluxoNaTela {
  flowKey: string;
  rotulo: string;
  fila: string;
  podeAtivar: boolean;
  motivoDoBloqueio: string | null;
  /** O que a confirmação de "Sincronizar agora" mostra. Vem do catálogo de fluxos. */
  avisoAoExecutarAgora: string;
  janelaSemSucessoHoras: number;
  desejado: AgendaDoFluxo | null;
  observado: SchedulerObservado | null;
  divergencias: string[];
  /** Revisão gravada que nenhum worker confirmou ainda. Informação, não defeito. */
  revisaoPendente: boolean;
  /** O Redis já está com o cron e o fuso desejados. */
  observadoConfere: boolean;
  proximosDisparos: string[];
  ultimoRun: RunResumo | null;
  ultimoSucessoEm: string | null;
}

export interface Painel {
  fluxos: FluxoNaTela[];
  orfaos: SchedulerObservado[];
  dlq: {
    total: number;
    recentes: Array<{ jobId?: string; sourceQueue: string; jobName: string; failedReason: string; failedAt: string }>;
  };
}

export interface PreviaDeCron {
  ok: true;
  cron: string;
  proximos: string[];
  intervaloMinimoMinutos: number;
  avisoDeFolga: string | null;
  colide: boolean;
  motivo: string | null;
}

export interface Mapeamento {
  entityType: string;
  rmCode: string;
  toddleId: string;
  state: string;
  curriculumId: string | null;
  archiveReason?: string | null;
  lastSeenInScopeAt?: string | null;
}

export interface Proposta {
  forma: 'vincular' | 'revincular' | 'arquivar';
  entityType: string;
  rmCode: string;
  toddleId?: string;
  curriculumId?: string;
  motivo: string;
}

export interface PropostaPendente {
  operationId: string;
  proposta: Proposta;
  snapshot: { toddleId?: string; state?: string; curriculumId?: string | null } | null;
  criadoPor: string | null;
  criadoPorQuem: string | null;
  criadoEm: string;
}

export interface EventoDeAuditoria {
  id: string;
  ocorridoEm: string;
  ator: string;
  acao: string;
  entidade?: string;
  entidadeId?: string;
  antes?: unknown;
  depois?: unknown;
  motivo?: string;
  resultado?: string;
  quem?: string;
}

export const api = {
  authConfig: () => pedir<AuthConfig>('/auth/config'),
  health: () => pedir<{
    ok: boolean; authMode: string; tenant: string; configVersion: string;
    dependencias: Array<{
      nome: string;
      ok: boolean;
      /** `limitado` = rate limit. NÃO é queda — ver o /health na API. */
      estado: 'ok' | 'limitado' | 'falha';
      erro?: string;
      liberaEmSegundos?: number;
    }>;
  }>('/health'),
  config: () => pedir<Record<string, string>>('/config'),
  resumo: () => pedir<{
    tenant: string;
    itens: Array<{ entityType: string; state: string; total: number }>;
  }>('/mappings/summary'),
  auditoriaYearGroups: (curriculumId: string) => pedir<{
    curriculumId: string; yearGroupsNoToddle: number; mapeamentos: number;
    problemas: Array<{ rmCode: string; toddleId: string; curriculumIdRegistrado: string | null; causa: string }>;
  }>(`/pendencias/year-groups?curriculumId=${encodeURIComponent(curriculumId)}`),

  // ─── Agenda ───────────────────────────────────────────────────────────────
  painel: () => pedir<Painel>('/agenda'),
  jobs: () => pedir<PainelDeJobs>('/jobs'),
  executarAgora: (flowKey: string, motivo?: string) =>
    pedir<{ enfileirado: boolean; jobId: string | null; fila: string; aplicacao: string }>(
      `/agenda/${flowKey}/executar`,
      'POST',
      { motivo },
    ),
  previa: (flowKey: string, cron: string) =>
    pedir<PreviaDeCron>(`/agenda/${encodeURIComponent(flowKey)}/previa`, 'POST', { cron }),
  salvarAgenda: (flowKey: string, mudanca: { cron?: string; ativo?: boolean; motivo?: string }) =>
    pedir<{
      antes: AgendaDoFluxo; depois: AgendaDoFluxo; proximosDisparos: string[]; aplicacao: string;
    }>(`/agenda/${encodeURIComponent(flowKey)}`, 'PUT', mudanca),
  auditoria: (limite = 40) => pedir<{ eventos: EventoDeAuditoria[] }>(`/auditoria?limite=${limite}`),

  // ─── De-para ──────────────────────────────────────────────────────────────
  buscarMapeamentos: (q: string) =>
    pedir<{ q: string; total: number; itens: Mapeamento[] }>(`/mappings/busca?q=${encodeURIComponent(q)}`),
  duplicatas: () =>
    pedir<{ total: number; itens: Array<{ entityType: string; toddleId: string; rmCodes: string[] }>; leia: string }>(
      '/mappings/duplicatas',
    ),
  orfaos: (entityType: string, curriculumId?: string) =>
    pedir<{ entityType: string; idsVivosNoToddle: number; total: number; fonte: string; itens: Mapeamento[] }>(
      `/mappings/orfaos?entityType=${encodeURIComponent(entityType)}` +
        (curriculumId ? `&curriculumId=${encodeURIComponent(curriculumId)}` : ''),
    ),
  curriculos: () =>
    pedir<{ organizacao: string; itens: Array<{ id: string; name?: string }> }>('/curriculos'),

  // ─── Propostas de vínculo ─────────────────────────────────────────────────
  propostas: () => pedir<{ formas: string[]; itens: PropostaPendente[] }>('/propostas'),
  propor: (p: Proposta) =>
    pedir<{ operationId: string; proximoPasso: string }>('/propostas', 'POST', p),
  decidirProposta: (id: string, decisao: 'approved' | 'rejected', motivo: string) =>
    pedir<{ ok: true; estado: string; antes: unknown; depois: unknown }>(
      `/propostas/${encodeURIComponent(id)}/decidir`, 'POST', { decisao, motivo },
    ),
};

/** ─── a aba Jobs ─────────────────────────────────────────────────────────── */

export interface ProgressoDeJob {
  fase: string;
  /** Só existe junto com `total`. Ausente = a fase não tem denominador. */
  feitos?: number;
  total?: number;
}

export interface JobAtivo {
  id: string | null;
  nome: string;
  progresso: ProgressoDeJob | null;
  iniciadoEm: string | null;
  tentativa: number;
}

export interface RunNoGrafico {
  chave: string;
  desfecho: 'succeeded' | 'failed' | 'executing';
  inicioEm: string;
  duracaoMs: number;
  lotes?: { feitos: number; total: number };
}

export interface JobTerminado {
  id: string | null;
  nome: string;
  desfecho: 'completed' | 'failed';
  terminadoEm: string | null;
  duracaoMs: number | null;
  tentativas: number;
  /** O retorno do processador. É onde aparece `{ desligado: true }`. */
  retorno: unknown;
  erro: string | null;
  manual: boolean;
}

export interface FluxoDeJobs {
  flowKey: string;
  rotulo: string;
  fila: string;
  contagem: { ativos: number; esperando: number; reservaDeCron: number };
  ativos: JobAtivo[];
  terminados: JobTerminado[];
  /** Progresso por lote do fan-out de aluno. `null` nos demais. */
  lotesEmCurso: { feitos: number; total: number } | null;
  historico: RunNoGrafico[];
  historicoSuficiente: boolean;
  minimoParaGrafico: number;
}

export interface PainelDeJobs {
  fluxos: FluxoDeJobs[];
  dlq: { total: number; recentes: Array<{ jobId?: string; jobName: string; failedAt: string; failedReason: string }> };
  retencao: { concluidosNoRedisHoras: number; falhosNoRedisDias: number; duravelEm: string };
}
