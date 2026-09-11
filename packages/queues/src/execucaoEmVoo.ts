/**
 * "Já existe uma execução deste fluxo em voo?"
 *
 * ─── POR QUE ISTO É UMA FUNÇÃO PURA, E TESTADA ──────────────────────────────
 *
 * Porque eu errei duas vezes seguidas escrevendo isto inline na rota.
 *
 * A primeira versão somava `waiting + active + delayed` e recusava se > 0. Não
 * pegava fila PAUSADA (o job cai em `paused`) — medido: dois `add` seguidos
 * responderam 200.
 *
 * A segunda somava TUDO menos `completed` e `failed`. Aí passou a recusar
 * SEMPRE em fluxo ligado, e a razão só aparece olhando os jobs de verdade: o
 * Job Scheduler do BullMQ mantém, permanentemente, um job `delayed` que é o
 * MARCADOR do próximo disparo do cron:
 *
 *     id=repeat:students.sync:1789138800000  repeatJobKey=students.sync
 *     opts.repeat={pattern:"0 3,9,12,16 * * *"}  delay=8170358
 *
 * Esse marcador não é trabalho pendente — é uma reserva de horário. Contá-lo
 * tornava o botão inútil em qualquer fluxo ligado, que é o caso normal. O bug
 * escapou porque testei só no fluxo de NOTAS, o único desligado, e portanto o
 * único sem scheduler.
 *
 * ─── A DISTINÇÃO CERTA ──────────────────────────────────────────────────────
 *
 * Não é "veio do scheduler": um job do cron que JÁ DISPAROU e está rodando deve
 * bloquear o disparo manual, senão os dois rodam em sequência e o segundo
 * reescreve o que o primeiro acabou de escrever.
 *
 * A distinção é entre **trabalho pendente** e **marcador de futuro**:
 *
 *   delayed + repeatJobKey   -> reserva do próximo cron. IGNORA.
 *   delayed sem repeatJobKey -> job em backoff entre tentativas. CONTA.
 *   waiting / active / paused / prioritized, de qualquer origem -> CONTA.
 */

/** O mínimo que se precisa saber de um job para decidir. */
export interface JobEmVoo {
  /** Estado do BullMQ. */
  estado: 'waiting' | 'active' | 'delayed' | 'paused' | 'prioritized';
  /**
   * Preenchido pelo BullMQ quando o job pertence a um Job Scheduler.
   * `undefined` em job avulso.
   */
  repeatJobKey?: string | null;
}

/** Estados que podem conter trabalho pendente. `completed` e `failed` não. */
export const ESTADOS_NAO_TERMINAIS = [
  'waiting',
  'active',
  'delayed',
  'paused',
  'prioritized',
] as const;

/**
 * É o marcador que o scheduler deixa reservando o próximo disparo?
 *
 * Só `delayed` conta como marcador: assim que o cron dispara, o job vira
 * `waiting`/`active` e passa a ser trabalho de verdade, mesmo mantendo o
 * `repeatJobKey`.
 */
export function eMarcadorDeProximoDisparo(job: JobEmVoo): boolean {
  return job.estado === 'delayed' && Boolean(job.repeatJobKey);
}

/** Os que representam trabalho pendente de verdade. */
export function execucoesEmVoo(jobs: JobEmVoo[]): JobEmVoo[] {
  return jobs.filter((j) => !eMarcadorDeProximoDisparo(j));
}
