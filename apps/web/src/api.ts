/**
 * Único ponto de contato da UI com o mundo externo.
 *
 * A UI NUNCA fala com RM, Toddle, Redis ou Postgres — só com esta API. Não é
 * preferência de estilo: se a interface pudesse chamar os sistemas direto, toda
 * validação de "o que pode ser escrito" viraria decoração, porque bastaria um
 * `curl` para contorná-la. A regra vive no servidor.
 */
const BASE = 'http://127.0.0.1:3333';

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

async function pedir<T>(rota: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (idToken) headers.Authorization = `Bearer ${idToken}`;

  const r = await fetch(BASE + rota, { headers });
  const texto = await r.text();
  const corpo = texto ? JSON.parse(texto) : null;

  if (!r.ok) {
    const msg = (corpo as { erro?: string })?.erro ?? `HTTP ${r.status}`;
    throw new ApiError(r.status, corpo, msg);
  }
  return corpo as T;
}

export const api = {
  authConfig: () => pedir<AuthConfig>('/auth/config'),
  health: () => pedir<{
    ok: boolean; authMode: string; tenant: string; configVersion: string;
    dependencias: Array<{ nome: string; ok: boolean; erro?: string }>;
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
};
