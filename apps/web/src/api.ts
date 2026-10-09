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

/**
 * A autenticação é um COOKIE, não um header.
 *
 * Antes, o ID token do Google ficava aqui em memória e ia em toda requisição.
 * Isso amarrava a sessão ao prazo do Google (1 hora) e a perdia a cada
 * recarregar de página — e não havia como deslogar ninguém.
 *
 * Agora o token do Google é apresentado UMA vez em `POST /auth/sessao` e o que
 * circula é um cookie `HttpOnly`, que o JavaScript desta página nem enxerga —
 * estritamente melhor que guardar em `localStorage`, que qualquer script lê.
 *
 * `credentials: 'include'` em todas as chamadas é o que faz o navegador mandar
 * esse cookie para a API em outra origem (Vite na 5173, API na 3333).
 */
export async function abrirSessao(idTokenDoGoogle: string): Promise<{ expiraEm: string; papeis: string[] }> {
  return pedir('/auth/sessao', 'POST', undefined, { Authorization: `Bearer ${idTokenDoGoogle}` });
}

export async function encerrarSessao(): Promise<void> {
  await pedir('/auth/sair', 'POST');
}

/**
 * Há sessão válida? Lança `ApiError` 401 quando não há.
 *
 * Devolve também os PAPÉIS, que é o que permite a tela não desenhar uma aba que
 * a pessoa não pode abrir. Esconder a aba é cortesia; a porta continua trancada
 * do lado do servidor, em cada rota.
 */
export async function quemSouEu(): Promise<{
  subject: string;
  email: string | null;
  papeis: Papel[];
}> {
  return pedir('/auth/eu');
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly corpo: unknown, mensagem: string) {
    super(mensagem);
  }
}

async function pedir<T>(
  rota: string,
  metodo = 'GET',
  corpoEnviado?: unknown,
  headersExtra: Record<string, string> = {},
): Promise<T> {
  const headers: Record<string, string> = { ...headersExtra };
  if (corpoEnviado !== undefined) headers['Content-Type'] = 'application/json';

  const r = await fetch(BASE + rota, {
    method: metodo,
    headers,
    // Manda o cookie de sessão. Sem isto o navegador o omite em origem
    // diferente, e toda chamada volta 401 sem explicação aparente.
    credentials: 'include',
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
  /**
   * `null` = nada rodando. Preenchido = já há execução em voo, e o botão de
   * rodar agora nasce travado. A guarda de verdade continua sendo o 409 do POST.
   */
  execucaoEmVoo: { quantidade: number; desde: string | null } | null;
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
  /** Passada pedida por um detector, esperando o ritmo do fluxo. */
  passadaAgendadaPara?: string | null;
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

// ─── Acessos ────────────────────────────────────────────────────────────────

/** Os cinco papéis do CHECK de `membership` (migration 006). */
export type Papel =
  | 'viewer'
  | 'mapping_manager'
  | 'integration_operator'
  | 'approver'
  | 'tenant_admin';

export interface PessoaComAcesso {
  userIdentityId: string;
  provider: string;
  subject: string;
  email: string | null;
  nome: string | null;
  papeis: Papel[];
}

export interface PessoaAguardando {
  userIdentityId: string;
  provider: string;
  subject: string;
  email: string | null;
  nome: string | null;
  /** Quando ela tentou entrar pela primeira vez. */
  desde: string;
}

export interface PainelDeAcessos {
  papeis: Papel[];
  comAcesso: PessoaComAcesso[];
  aguardando: PessoaAguardando[];
  /** Quantos têm `tenant_admin`. Com 1, remover o papel é recusado. */
  administradores: number;
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

  // ─── Tempo quase real ─────────────────────────────────────────────────────
  continuo: () => pedir<PainelContinuo>('/continuo'),
  salvarContinuo: (
    chave: string,
    mudanca: {
      ativo?: boolean; intervaloSegundos?: number; horaInicio?: number; horaFim?: number; retomar?: boolean; motivo?: string;
    },
  ) =>
    pedir<{ antes: LinhaDoDetector; depois: LinhaDoDetector; aplicacao: string }>(
      `/continuo/${encodeURIComponent(chave)}`,
      'PUT',
      mudanca,
    ),

  // ─── Acessos ──────────────────────────────────────────────────────────────
  acessos: () => pedir<PainelDeAcessos>('/acessos'),
  conceder: (userIdentityId: string, papel: Papel, motivo?: string) =>
    pedir<{ ok: boolean; jaTinha: boolean; papel: Papel }>('/acessos', 'POST', {
      userIdentityId, papel, motivo,
    }),
  revogar: (userIdentityId: string, papel: Papel, motivo?: string) =>
    pedir<{ ok: boolean; naoTinha: boolean; papel: Papel }>('/acessos/revogar', 'POST', {
      userIdentityId, papel, motivo,
    }),

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

  // ─── Sentenças do RM ──────────────────────────────────────────────────────
  sentencas: () => pedir<PainelDeSentencas>('/sentencas'),
  conferirSentencas: () => pedir<PainelDeSentencas>('/sentencas/conferir', 'POST'),
  restaurarSentencas: (motivo: string, codigos?: string[]) =>
    pedir<ResultadoDaCarga>('/sentencas/restaurar', 'POST', { motivo, codigos }),

  // ─── Propostas de vínculo ─────────────────────────────────────────────────
  propostas: () => pedir<{ formas: string[]; itens: PropostaPendente[] }>('/propostas'),
  propor: (p: Proposta) =>
    pedir<{ operationId: string; proximoPasso: string }>('/propostas', 'POST', p),
  decidirProposta: (id: string, decisao: 'approved' | 'rejected', motivo: string) =>
    pedir<{ ok: true; estado: string; antes: unknown; depois: unknown }>(
      `/propostas/${encodeURIComponent(id)}/decidir`, 'POST', { decisao, motivo },
    ),
};

/** ─── a aba Sentenças ────────────────────────────────────────────────────── */

/**
 * O resultado das três camadas de aceite de uma Sentença. Espelha
 * `ConferenciaDeSentenca` no servidor — e é intencional que cada camada traga o
 * seu `detalhe` em texto: a tela não interpreta, ela mostra o que foi medido.
 */
export interface ConferenciaDeSentenca {
  codigo: string;
  existeNoRm: boolean;
  confere: boolean;
  verificacaoCompleta: boolean;
  releitura: { ok: boolean; detalhe: string };
  execucao: { ok: boolean; detalhe: string; colunasAusentes: string[] };
  volume: { ok: boolean; linhas: number | null; detalhe: string };
  reprovouEm: 'releitura' | 'execucao' | 'volume' | null;
  /** Aviso que não reprova — tipicamente coluna que veio nula em todas as linhas. */
  aviso: string | null;
}

export interface RestauracaoDeSentenca extends ConferenciaDeSentenca {
  gravou: boolean;
  desconhecido: boolean;
  respostaDoRm: string | null;
}

export interface PainelDeSentencas {
  coligada: string;
  periodoLetivo: string | null;
  apenasReleitura: boolean;
  itens: ConferenciaDeSentenca[];
  ausentes: number;
  divergentes: number;
  filasPausadas: string[];
}

export interface ResultadoDaCarga {
  pedidas: number;
  restauradas: number;
  gravadas: number;
  falharam: number;
  filasPausadasDurante: string[];
  filasPausadasAgora: string[];
  itens: RestauracaoDeSentenca[];
  aindaFalta: string | null;
}

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
  /** `preso` = aberto e sem notícia de lote nenhum há 15 min. Ver /jobs na API. */
  desfecho: 'succeeded' | 'failed' | 'executing' | 'preso';
  inicioEm: string;
  duracaoMs: number;
  lotes?: { feitos: number; total: number };
  semNoticiaHaMs?: number;
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
  /** Quem pediu: o botão, a agenda ou um detector de mudança. */
  origem: 'manual' | 'continuo' | 'agenda';
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
  runsPresos: RunNoGrafico[];
  historico: RunNoGrafico[];
  historicoSuficiente: boolean;
  minimoParaGrafico: number;
}

export interface PainelDeJobs {
  fluxos: FluxoDeJobs[];
  dlq: { total: number; recentes: Array<{ jobId?: string; jobName: string; failedAt: string; failedReason: string }> };
  retencao: { concluidosNoRedisHoras: number; falhosNoRedisDias: number; duravelEm: string };
}

/** ─── Tempo quase real ───────────────────────────────────────────────────── */

export type SituacaoDoDetector =
  | 'sem-linha'
  | 'desligado'
  | 'pausado'
  | 'fora-do-horario'
  | 'com-erro'
  | 'parado'
  | 'ativo';

/** A linha de `fluxo_continuo`: intenção e o que o worker observou. */
export interface LinhaDoDetector {
  chave: string;
  ativo: boolean;
  intervaloSegundos: number;
  horaInicio: number;
  horaFim: number;
  timezone: string;
  atualizadoPor: string | null;
  atualizadoEm: string;
  ultimaSondagemEm: string | null;
  ultimaMudancaEm: string | null;
  ultimoDisparo: { desfechos: Record<string, string>; resumo: string; inicios?: Record<string, string> } | null;
  ultimoDisparoEm: string | null;
  ultimoErro: string | null;
  ultimoErroEm: string | null;
  falhasSeguidas: number;
  pausadoAte: string | null;
  contadores: { dia?: string; sondagens?: number; mudancas?: number; disparos?: number };
}

export interface DetectorNaTela {
  chave: string;
  rotulo: string;
  direcao: string;
  pergunta: string;
  custoPorVolta: string;
  avisoAoLigar: string;
  padrao: { intervaloSegundos: number; horaInicio: number; horaFim: number };
  fluxos: Array<{ key: string; rotulo: string; ligado: boolean }>;
  situacao: SituacaoDoDetector;
  explicacao: string;
  janela: string | null;
  linha: LinhaDoDetector | null;
}

export interface EstadoDaCota {
  ativo: boolean;
  capacidade: number;
  janelaSegundos: number;
  disponiveis: number;
  cooldownSegundos: number;
}

export interface PainelContinuo {
  agora: string;
  cota: EstadoDaCota | null;
  /** O RM recusou a credencial: todos os detectores esperam até `ate`. */
  travaDoRm: { ate: string; recusas: number; motivo: string } | null;
  detectores: DetectorNaTela[];
}
