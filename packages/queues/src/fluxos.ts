import { QUEUE } from './names';
import { STAFF_JOB, STUDENT_JOB, TERM_GRADE_JOB } from './names';

/**
 * CATÁLOGO DOS FLUXOS — o que a tela de agendamento pode agendar.
 *
 * ─── POR QUE ISTO MORA NO CÓDIGO, E NÃO NO BANCO ────────────────────────────
 *
 * A tabela `flow_schedule` (migration 016) guarda só `(cron, timezone, ativo)`
 * por `flow_key`. A tradução `flow_key -> fila + nome do job` fica aqui, imutável,
 * de propósito: uma tabela que definisse fila e payload transformaria a tela numa
 * máquina de enfileirar job arbitrário no Redis. Quem tiver acesso à tela poderia
 * inventar um fluxo que ninguém escreveu.
 *
 * A consequência prática é a que se quer: horário e liga/desliga mudam em runtime;
 * criar um fluxo novo é escrever código, revisar e deployar.
 *
 * ─── O `flow_key` É TAMBÉM O ID DO SCHEDULER NO BULLMQ ──────────────────────
 *
 * Estável, nunca derivado do cron. Key derivada do cron faria cada edição de
 * horário criar um scheduler NOVO e abandonar o velho — ativo, invisível e
 * disparando para sempre. O `flow_key` também é o `tipo` gravado em `job_run`,
 * então "qual foi o último run deste fluxo?" é uma consulta direta.
 */

export const FLOW = {
  ALUNOS: 'students.sync',
  PROFESSORES: 'staff.sync',
  NOTAS: 'term-grades.sync',
} as const;

export type FlowKey = (typeof FLOW)[keyof typeof FLOW];

export interface Fluxo {
  key: FlowKey;
  /** Como a tela chama isto. Escrito para quem opera, não para quem programa. */
  rotulo: string;
  fila: string;
  /** Nome do job que o scheduler enfileira. */
  job: string;
  /**
   * Horas sem run bem-sucedido antes de o vigia alertar.
   *
   * O número não é redondo por gosto: o cron de cadastro roda 4x ao dia em
   * intervalos DESIGUAIS (03:00, 09:00, 12:00, 16:00), o que deixa uma janela de
   * 11h entre o último e o primeiro do dia seguinte. Limiar de 8h alertaria toda
   * madrugada, e alerta que grita por nada é alerta que passa a ser ignorado — a
   * mesma conta que o comentário do HEARTBEAT_URL_* já fazia em env.ts.
   */
  janelaSemSucessoHoras: number;
  /**
   * `false` quando o fluxo NÃO pode ser ativado pela tela, com o motivo.
   *
   * Existe porque ligar um fluxo cujo destino está provado morto não é neutro: o
   * job entra na fila, falha as três tentativas e cai na DLQ a cada disparo. Um
   * interruptor que produz só isso não é um interruptor, é uma armadilha — e a
   * tela precisa explicar em vez de deixar a pessoa descobrir pela DLQ.
   */
  podeAtivar: boolean;
  motivoDoBloqueio?: string;
}

export const FLUXOS: Record<FlowKey, Fluxo> = {
  [FLOW.ALUNOS]: {
    key: FLOW.ALUNOS,
    rotulo: 'Alunos (RM → Toddle)',
    fila: QUEUE.RM_TO_TODDLE_STUDENTS,
    job: STUDENT_JOB.EXTRACT,
    janelaSemSucessoHoras: 13,
    podeAtivar: true,
  },
  [FLOW.PROFESSORES]: {
    key: FLOW.PROFESSORES,
    rotulo: 'Professores (RM → Toddle)',
    fila: QUEUE.RM_TO_TODDLE_STAFF,
    job: STAFF_JOB.SYNC,
    janelaSemSucessoHoras: 13,
    podeAtivar: true,
  },
  [FLOW.NOTAS]: {
    key: FLOW.NOTAS,
    rotulo: 'Notas (Toddle → RM)',
    fila: QUEUE.TODDLE_TO_RM_TERM_GRADES,
    job: TERM_GRADE_JOB.SYNC,
    // Nota muda quando o professor digita, e o pedido é que chegue perto disso.
    // Janela curta porque o poll é curto — mas ver `podeAtivar` abaixo.
    janelaSemSucessoHoras: 4,
    podeAtivar: false,
    motivoDoBloqueio:
      'o destino desta via está provado morto: medido em 09/09/2026, o SaveRecord do ' +
      'EduNotaEtapaData aceita o dataset, responde ok=true e DESCARTA o NOTAFALTA — o job ' +
      'criaria nota ZERO no histórico escolar, em silêncio. O processador RECUSA rodar por ' +
      'isso. Redirecione-o para a nota de AVALIAÇÃO (SProvas + SNotas, `npm run ' +
      'escrever:avaliacoes`) e troque este `podeAtivar` no mesmo commit.',
  },
};

/** Lista na ordem em que a tela mostra. */
export const FLUXOS_EM_ORDEM: Fluxo[] = [
  FLUXOS[FLOW.ALUNOS],
  FLUXOS[FLOW.PROFESSORES],
  FLUXOS[FLOW.NOTAS],
];

/** `undefined` quando a chave não é de fluxo nenhum — a API responde 400 com a lista. */
export function acharFluxo(key: string): Fluxo | undefined {
  return (FLUXOS as Record<string, Fluxo>)[key];
}
