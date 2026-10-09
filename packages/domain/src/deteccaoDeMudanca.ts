import { hashDoPayload } from './payloadHash';

/**
 * DETECÇÃO DE MUDANÇA — a parte pura do "tempo quase real".
 *
 * ─── A PERGUNTA QUE ISTO RESPONDE ───────────────────────────────────────────
 *
 * "Desde a última olhada, apareceu alguma coisa que eu ainda não vi?"
 *
 * Nenhuma das duas pontas avisa quando algo muda: o Toddle não tem webhook
 * (verificado na coleção inteira em 09/09 e de novo em 09/10/2026) e o RM, no
 * CloudTOTVS, só alcança fora por Fórmula Visual que ninguém configurou. Então o
 * detector PERGUNTA, de minuto em minuto, com o filtro mais barato que cada
 * lado oferece — e o que ele pergunta é "mudou?", nunca "me dá tudo".
 *
 * ─── POR QUE IMPRESSÃO + CARIMBO, E NÃO SÓ UMA MARCA D'ÁGUA ─────────────────
 *
 * Marca d'água pura ("tudo depois de X") só funciona se o filtro for exato e os
 * relógios concordarem. Aqui nenhum dos dois vale:
 *
 *   - `/attendance?modifiedSince` só aceita DIA (com hora devolve 400);
 *   - `EduMatricPLData` e `RhuPessoaData` filtram por `RECMODIFIEDON` mas NÃO
 *     devolvem a coluna, então não há valor lido para avançar a marca;
 *   - o `RECMODIFIEDON` do RM vem sem fuso, na hora do servidor.
 *
 * A saída é consultar com FOLGA (uma janela que se sobrepõe à anterior) e
 * lembrar o que já foi visto. Cada linha vira uma impressão (hash do conteúdo) e
 * um carimbo (quando ela mudou, ou quando a vimos pela primeira vez). Linha
 * repetida pela sobreposição não é novidade; linha cujo conteúdo mudou tem
 * impressão nova e é. A memória esquece o que ficou para trás do `desde`, porque
 * aquilo não volta mais na consulta.
 *
 * ─── O DETECTOR ACELERA, NÃO SUBSTITUI ──────────────────────────────────────
 *
 * Se algo escapar daqui — relógio fora da folga, registro além da primeira
 * página —, a varredura agendada continua passando por tudo. É ela que garante;
 * o detector só encurta a espera.
 */

/** Uma linha observada numa sondagem, já reduzida ao que a memória precisa. */
export interface LinhaObservada {
  /** Hash do conteúdo. Mudou o conteúdo, mudou a impressão. */
  impressao: string;
  /**
   * Quando a linha mudou, no formato da própria fonte. Comparado como texto com
   * o `desde` da MESMA fonte, então os dois têm de estar no mesmo formato.
   */
  carimbo: string;
}

/** impressão -> carimbo. Persistido entre voltas, em `fluxo_continuo.estado`. */
export type MemoriaDeVistos = Record<string, string>;

/**
 * Teto da memória. Num minuto normal ela guarda dezenas de linhas; milhares
 * significa que o `desde` parou de andar, e crescer sem limite transformaria
 * uma coluna jsonb num arquivo. Corta mantendo as mais recentes.
 */
export const TETO_DA_MEMORIA = 20_000;

/**
 * Separa o que é novo e devolve a memória atualizada.
 *
 * Quem continua voltando na consulta tem o carimbo RENOVADO (fica o maior). É o
 * que protege as fontes sem coluna de modificação, cujo carimbo é "quando vi":
 * se o relógio do RM estiver adiantado além da folga, a linha segue voltando
 * depois que o nosso carimbo dela envelheceu — e sem a renovação ela seria
 * esquecida e redetectada como nova a cada folga, disparando o fluxo à toa.
 * Quando a consulta para de devolvê-la, o carimbo para de andar e ela envelhece.
 */
export function separarNovidades(
  linhas: readonly LinhaObservada[],
  vistos: MemoriaDeVistos,
  desdeNovo: string,
): { novas: LinhaObservada[]; vistos: MemoriaDeVistos } {
  const novas: LinhaObservada[] = [];
  const memoria: MemoriaDeVistos = { ...vistos };
  for (const l of linhas) {
    const visto = memoria[l.impressao];
    if (visto !== undefined) {
      if (l.carimbo > visto) memoria[l.impressao] = l.carimbo;
      continue;
    }
    memoria[l.impressao] = l.carimbo;
    novas.push(l);
  }

  // Esquece o que ficou para trás: não volta mais na consulta seguinte.
  let mantidas = Object.entries(memoria).filter(([, carimbo]) => carimbo >= desdeNovo);
  if (mantidas.length > TETO_DA_MEMORIA) {
    mantidas = mantidas.sort(([, a], [, b]) => (a < b ? 1 : a > b ? -1 : 0)).slice(0, TETO_DA_MEMORIA);
  }
  return { novas, vistos: Object.fromEntries(mantidas) };
}

/** Impressão de uma linha qualquer, estável à ordem das chaves. */
export function impressaoDe(prefixo: string, linha: unknown): string {
  return `${prefixo}:${hashDoPayload(linha).slice(0, 24)}`;
}

/** O maior de dois carimbos no mesmo formato. `undefined` perde sempre. */
export function maiorCarimbo(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a >= b ? a : b;
}

/**
 * A hora do relógio de parede num fuso, de 0 a 23.
 *
 * `hourCycle: 'h23'` e não `hour12: false`: este último devolve "24" à meia-noite
 * em alguns motores, e a janela 0–6 deixaria de casar exatamente no horário em
 * que menos alguém está olhando.
 */
export function horaNoFuso(agora: Date, fuso: string): number {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: fuso, hour: 'numeric', hourCycle: 'h23' })
    .format(agora);
  return Number(h) % 24;
}

/**
 * O detector deve sondar agora?
 *
 * `inicio === fim` é o dia inteiro. `inicio > fim` atravessa a meia-noite
 * (22 → 6 é a madrugada) — aceito porque é o que alguém digitaria para "só à
 * noite", e recusar seria pior que entender.
 */
export function dentroDoHorario(agora: Date, fuso: string, horaInicio: number, horaFim: number): boolean {
  if (horaInicio === horaFim) return true;
  const h = horaNoFuso(agora, fuso);
  return horaInicio < horaFim ? h >= horaInicio && h < horaFim : h >= horaInicio || h < horaFim;
}

/**
 * `YYYY-MM-DDTHH:mm:ss` no relógio de parede de um fuso.
 *
 * É o formato que o `RECMODIFIEDON` do RM devolve (sem fuso, na hora do
 * servidor) e que o filtro do `ReadView` aceita — medido em 09/10/2026 com
 * controle de data futura devolvendo zero linhas nos cinco DataServers.
 */
export function instanteNoFuso(d: Date, fuso: string): string {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: fuso,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${partes.year}-${partes.month}-${partes.day}T${partes.hour}:${partes.minute}:${partes.second}`;
}

/** A data `YYYY-MM-DD` num fuso. É o que vira a chave do contador diário. */
export function diaNoFuso(d: Date, fuso: string): string {
  return instanteNoFuso(d, fuso).slice(0, 10);
}

/**
 * Quanto esperar depois de `falhas` voltas seguidas com erro.
 *
 * Dobra a cada falha, a partir do intervalo normal, com teto de 15 minutos. O
 * caso que isto existe para atender é a cópia de base: o RM fica mudo por HORAS
 * (ver a memória do projeto), e um detector que insistisse de minuto em minuto
 * passaria a tarde gerando timeout no log sem ninguém ganhar nada.
 *
 * Recusa de credencial NÃO passa por aqui — ela pausa direto, porque insistir
 * é o que BLOQUEIA o usuário da integração no RM (seis tentativas, medido em
 * 29/09/2026).
 */
export const ESPERA_MAXIMA_APOS_FALHA_MS = 15 * 60_000;

export function esperaAposFalha(falhas: number, intervaloMs: number): number {
  if (falhas <= 0) return intervaloMs;
  return Math.min(intervaloMs * 2 ** falhas, ESPERA_MAXIMA_APOS_FALHA_MS);
}

/**
 * Recua um carimbo do Toddle (`YYYY-MM-DD HH:MM:SS[.ffffff]`, SEM fuso) e devolve
 * no formato que o `fromDate` aceita, sem fração.
 *
 * É aritmética de relógio de parede: o carimbo é lido COMO SE fosse UTC só para
 * subtrair, e escrito de volta igual. Como o fuso nunca é aplicado nem removido,
 * ele não importa — a mesma régua entra e sai.
 */
export function recuarCarimboDoToddle(carimbo: string, ms: number): string {
  const base = Date.parse(`${carimbo.slice(0, 19).replace(' ', 'T')}Z`);
  if (Number.isNaN(base)) return carimbo.slice(0, 19);
  return new Date(base - ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Recua um instante de relógio de parede `YYYY-MM-DDTHH:mm:ss` (o formato do
 * `RECMODIFIEDON`), sem passar por fuso. Mesma aritmética de
 * `recuarCarimboDoToddle`; o Brasil não tem horário de verão desde 2019, e se
 * voltar a ter o erro máximo é de uma hora a mais de folga na noite da troca.
 */
export function recuarRelogioDeParede(instante: string, ms: number): string {
  const base = Date.parse(`${instante.slice(0, 19)}Z`);
  if (Number.isNaN(base)) return instante;
  return new Date(base - ms).toISOString().slice(0, 19);
}

/** Minuto do dia (0–1439) no relógio de parede de um fuso. */
export function minutoDoDiaNoFuso(agora: Date, fuso: string): number {
  const [h, m] = instanteNoFuso(agora, fuso).slice(11, 16).split(':').map(Number);
  return h * 60 + m;
}
