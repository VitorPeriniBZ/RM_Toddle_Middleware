import { FLOW, type FlowKey } from './fluxos';
import { execucoesEmVoo, type JobEmVoo } from './execucaoEmVoo';

/**
 * CATÁLOGO DOS DETECTORES DE MUDANÇA — o "tempo quase real".
 *
 * Um detector pergunta, no seu intervalo, "mudou algo desde a última vez?" e,
 * quando sim, dispara um fluxo do catálogo de `fluxos.ts`. Ele NÃO escreve em
 * lugar nenhum: quem escreve continua sendo o fluxo, com os mesmos guardas,
 * a mesma aprovação e o mesmo `job_run`. O detector só antecipa o disparo.
 *
 * Mesma regra do catálogo de fluxos: a tabela `fluxo_continuo` guarda só
 * liga/desliga, intervalo e horário. O que se sonda e o que se dispara mora
 * aqui, no código — senão a tela viraria uma máquina de enfileirar job.
 */

export const DETECTOR = {
  NOTAS: 'notas',
  FREQUENCIA: 'frequencia',
  CADASTRO: 'cadastro',
} as const;

export type ChaveDeDetector = (typeof DETECTOR)[keyof typeof DETECTOR];

export interface DefinicaoDeDetector {
  chave: ChaveDeDetector;
  /** Como a tela chama. Para quem opera, não para quem programa. */
  rotulo: string;
  direcao: 'Toddle → TOTVS' | 'TOTVS → Toddle';
  /** A pergunta que ele faz, e onde. */
  pergunta: string;
  /** Quanto cada volta custa, dito com o número medido. */
  custoPorVolta: string;
  /** Os fluxos que uma mudança dispara. */
  fluxos: FlowKey[];
  /** Valores da linha quando ela é criada. Ela nasce DESLIGADA. */
  padrao: { intervaloSegundos: number; horaInicio: number; horaFim: number };
  /** O que dizer a quem liga, ANTES de ligar. Específico, nunca "tem certeza?". */
  avisoAoLigar: string;
}

export const DETECTORES: Record<ChaveDeDetector, DefinicaoDeDetector> = {
  [DETECTOR.NOTAS]: {
    chave: DETECTOR.NOTAS,
    rotulo: 'Notas',
    direcao: 'Toddle → TOTVS',
    pergunta:
      'Alguma nota foi publicada no Toddle desde a última olhada? (`/progress-summary` filtrado ' +
      'pelo horário da última nota vista)',
    custoPorVolta: '1 chamada ao Toddle por currículo (2 hoje) — ~4% da cota com 1 volta por minuto',
    fluxos: [FLOW.NOTAS],
    padrao: { intervaloSegundos: 60, horaInicio: 6, horaFim: 22 },
    avisoAoLigar:
      'Nota PUBLICADA no Toddle passa a ir para o TOTVS em 1 a 2 minutos, pelo mesmo fluxo de ' +
      'Notas: nota lançada à mão no RM não é sobrescrita (vira pendência), e volume grande pede ' +
      'aprovação. Nota salva e não publicada só segue na próxima varredura agendada. Só dispara ' +
      'se o fluxo "Notas" estiver ligado na agenda.',
  },
  [DETECTOR.FREQUENCIA]: {
    chave: DETECTOR.FREQUENCIA,
    rotulo: 'Frequência',
    direcao: 'Toddle → TOTVS',
    pergunta:
      'Alguma chamada foi lançada ou alterada no Toddle? (primeira página do `/attendance` ' +
      'filtrado por data de modificação, só das turmas do de-para)',
    custoPorVolta: '1 chamada ao Toddle — ~2% da cota com 1 volta por minuto',
    fluxos: [FLOW.FREQUENCIA],
    padrao: { intervaloSegundos: 60, horaInicio: 6, horaFim: 22 },
    avisoAoLigar:
      'A chamada lançada no Toddle passa a ir para o TOTVS em 1 a 2 minutos, em vez de esperar a ' +
      'passada das 23h. Mesmo fluxo de Frequência: falta lançada à mão no RM não é apagada (vira ' +
      'pendência). Só dispara se o fluxo "Frequência" estiver ligado na agenda.',
  },
  [DETECTOR.CADASTRO]: {
    chave: DETECTOR.CADASTRO,
    rotulo: 'Cadastros',
    direcao: 'TOTVS → Toddle',
    pergunta:
      'Algum aluno, pessoa, matrícula, professor ou turma-disciplina mudou no RM? (`RECMODIFIEDON` ' +
      'nos cinco DataServers, filtrado no servidor)',
    custoPorVolta: '5 consultas leves ao RM (~0,5 s cada); o Toddle só é chamado quando algo mudou',
    fluxos: [FLOW.ALUNOS, FLOW.PROFESSORES, FLOW.TURMAS],
    padrao: { intervaloSegundos: 300, horaInicio: 6, horaFim: 22 },
    avisoAoLigar:
      'Mudança de cadastro no TOTVS passa a aparecer no Toddle em poucos minutos: aluno e pessoa ' +
      'disparam o fluxo de Alunos; professor e turma-disciplina disparam Professores e Turmas. Os ' +
      'fluxos são os mesmos da agenda — criar staff continua irreversível. Se o RM recusar a ' +
      'credencial, o detector PAUSA sozinho para não bloquear o usuário da integração.',
  },
};

export const DETECTORES_EM_ORDEM: DefinicaoDeDetector[] = [
  DETECTORES[DETECTOR.NOTAS],
  DETECTORES[DETECTOR.FREQUENCIA],
  DETECTORES[DETECTOR.CADASTRO],
];

export function acharDetector(chave: string): DefinicaoDeDetector | undefined {
  return DETECTORES_EM_ORDEM.find((d) => d.chave === chave);
}

/**
 * O RITMO de cada fluxo quando quem dispara é um detector.
 *
 * ─── POR QUE NÃO DISPARAR A CADA MUDANÇA ────────────────────────────────────
 *
 * A regra "um rodando, um esperando" impede fila infinita, mas não impede
 * passadas COLADAS: com professor publicando nota de minuto em minuto, o fluxo
 * de nota (que lê ~28 mil notas do RM) rodaria sem parar. O espaçamento
 * agrupa a rajada numa passada só, e o que chega no meio entra na seguinte.
 *
 * ─── O ATRASO DE PROFESSORES ────────────────────────────────────────────────
 *
 * Criar staff no Toddle é IRREVERSÍVEL: o e-mail vira a identidade da conta. Com
 * a agenda havia horas entre o cadastro no RM e a criação no Toddle — tempo de a
 * secretaria perceber o e-mail digitado errado. Disparar em 5 minutos tiraria
 * essa folga em silêncio. Os 30 minutos devolvem parte dela; o resto do
 * cadastro (aluno, matrícula) não tem esse custo e segue rápido.
 */
export interface RitmoDoFluxo {
  /** Espera depois de ver a mudança, antes da passada começar. */
  atrasoMs: number;
  /** Distância mínima entre o início de duas passadas disparadas por detector. */
  espacamentoMs: number;
}

const MIN = 60_000;

export const RITMO_POR_FLUXO: Record<FlowKey, RitmoDoFluxo> = {
  [FLOW.NOTAS]: { atrasoMs: 0, espacamentoMs: 3 * MIN },
  [FLOW.FREQUENCIA]: { atrasoMs: 0, espacamentoMs: 3 * MIN },
  [FLOW.ALUNOS]: { atrasoMs: 0, espacamentoMs: 5 * MIN },
  [FLOW.PROFESSORES]: { atrasoMs: 30 * MIN, espacamentoMs: 30 * MIN },
  [FLOW.TURMAS]: { atrasoMs: 0, espacamentoMs: 30 * MIN },
};

/**
 * Quando a passada pedida agora deve começar: o mais tarde entre "agora +
 * atraso" e "início da anterior + espaçamento".
 */
export function planejarInicio(agoraMs: number, inicioAnteriorMs: number | null, ritmo: RitmoDoFluxo): number {
  const pelaMudanca = agoraMs + ritmo.atrasoMs;
  const peloEspacamento = inicioAnteriorMs === null ? 0 : inicioAnteriorMs + ritmo.espacamentoMs;
  return Math.max(pelaMudanca, peloEspacamento);
}

/**
 * Prefixo do `jobId` dos disparos do detector. Três partes separadas por `:`
 * (`continuo:<fluxo>:<millis>`), que é o único formato com `:` que o BullMQ
 * aceita em id customizado — ver o incidente de 07/08 no README.
 */
export const PREFIXO_DO_DISPARO_CONTINUO = 'continuo:';

/** Um job da fila, do jeito que a decisão de disparo precisa vê-lo. */
export interface JobNaFila extends JobEmVoo {
  nome: string;
}

/**
 * Enfileirar, ou já há um esperando?
 *
 * ─── A REGRA: NO MÁXIMO UM RODANDO E UM ESPERANDO ───────────────────────────
 *
 * Um job ESPERANDO ainda não leu nada: quando ele começar, lerá o estado mais
 * novo, inclusive a mudança que acabou de ser vista. Enfileirar outro seria
 * pedir duas vezes a mesma leitura — então o pedido é absorvido.
 *
 * Um job RODANDO pode já ter lido a origem ANTES da mudança. Por isso ele NÃO
 * absorve: o detector enfileira um seguinte, que espera o atual terminar
 * (`concurrency: 1`) e roda com o estado novo. Sem isso, a nota publicada no
 * meio de uma passada só chegaria na varredura agendada seguinte.
 *
 * Só conta o job do PRÓPRIO fluxo (`nomeDoJob`): a fila de alunos também tem os
 * lotes do fan-out, que vieram de uma leitura já feita e não substituem uma nova.
 */
export function decidirDisparo(jobs: readonly JobNaFila[], nomeDoJob: string): 'enfileirar' | 'ja-na-fila' {
  const esperando = execucoesEmVoo(jobs.filter((j) => j.nome === nomeDoJob)).filter(
    (j) => j.estado !== 'active',
  );
  return esperando.length > 0 ? 'ja-na-fila' : 'enfileirar';
}

/**
 * É uma passada que um detector deixou AGENDADA (esperando o ritmo do fluxo)?
 *
 * Ela não é "execução em curso": ainda não começou, e pode ser antecipada. A
 * agenda a mostra à parte, e o "Sincronizar agora" a antecipa em vez de recusar
 * com "já existe uma execução na fila" — que seria verdade técnica e mentira
 * prática para quem esperaria 30 minutos olhando um botão desabilitado.
 */
export function eDisparoAgendadoDoDetector(j: { id?: string | null; estado: string; repeatJobKey?: string | null }): boolean {
  return j.estado === 'delayed' && !j.repeatJobKey && String(j.id ?? '').startsWith(PREFIXO_DO_DISPARO_CONTINUO);
}
