import { parseExpression } from 'cron-parser';
import { env } from './env';

/**
 * Validação e PRÉVIA de expressão cron — o que a tela de agendamento precisa
 * para nunca salvar um horário que ninguém conferiu.
 *
 * ─── POR QUE A PRÉVIA É CALCULADA NO SERVIDOR ───────────────────────────────
 *
 * Porque o usuário tem de confirmar o que VÊ, não o que digitou. `*\/30 6-22 * * *`
 * lido em UTC cai das 03:00 às 19:00 em São Paulo — a mesma string, dois
 * significados. Se a prévia fosse calculada no navegador, ela usaria o fuso da
 * máquina de quem olha, que não é necessariamente o fuso em que o job roda.
 *
 * Aqui ela é calculada com o MESMO fuso e a MESMA biblioteca que o BullMQ usa
 * (`cron-parser`, que é dependência dele), então a prévia é a execução.
 *
 * ─── POR QUE O INTERVALO MÍNIMO É REGRA DE SERVIDOR ─────────────────────────
 *
 * `* * * * *` digitado por engano não produz execução concorrente — os workers
 * são `concurrency: 1`. Produz BACKLOG: a fila enche mais rápido do que é
 * consumida, e o atraso aparece horas depois, longe da causa. Cada passada de
 * nota ainda lê ~7 mil linhas de Sentença no RM.
 *
 * A tela pode esconder o campo avançado; a guarda não pode viver na tela.
 */

/** Fuso de TODO agendamento deste middleware. A escola é uma, e é aqui. */
export const TZ_AGENDA = 'America/Sao_Paulo';

/** Quantos disparos a prévia devolve. Cinco é o suficiente para ver o padrão. */
const DISPAROS_NA_PREVIA = 5;

export type CronValidado =
  | { ok: true; cron: string; proximos: string[]; intervaloMinimoMinutos: number }
  | { ok: false; erro: string };

/**
 * Valida a expressão e devolve os próximos disparos em ISO 8601 com offset.
 *
 * ISO com offset, e não string local, porque a UI mostra o horário e o cliente
 * precisa saber que aquilo é -03:00 — não o fuso do navegador dele.
 */
export function validarCron(bruto: string, agora: Date = new Date()): CronValidado {
  const cron = bruto.trim().replace(/\s+/g, ' ');
  if (!cron) return { ok: false, erro: 'expressão cron vazia' };

  // Seis campos = cron com SEGUNDOS. O `cron-parser` aceita, e o BullMQ
  // obedeceria — o que transformaria um engano de formato em job por segundo.
  // Recusar aqui é mais claro que deixar a guarda de intervalo mínimo pegar
  // depois, porque a mensagem explica o que está errado.
  const campos = cron.split(' ').length;
  if (campos === 6) {
    return {
      ok: false,
      erro:
        'cron com 6 campos inclui SEGUNDOS, e nenhum fluxo aqui roda por segundo. ' +
        'Use 5 campos: minuto hora dia mês dia-da-semana',
    };
  }
  if (campos !== 5) {
    return { ok: false, erro: `cron deve ter 5 campos (recebido ${campos}): minuto hora dia mês dia-da-semana` };
  }

  let proximos: Date[];
  try {
    const intervalo = parseExpression(cron, { tz: TZ_AGENDA, currentDate: agora });
    proximos = Array.from({ length: DISPAROS_NA_PREVIA }, () => intervalo.next().toDate());
  } catch (err) {
    return { ok: false, erro: `expressão cron inválida: ${(err as Error).message}` };
  }

  const intervaloMinimoMinutos = menorIntervaloEmMinutos(proximos);
  if (intervaloMinimoMinutos < env.AGENDA_INTERVALO_MIN_MINUTOS) {
    return {
      ok: false,
      erro:
        `este cron dispara a cada ${intervaloMinimoMinutos} min, abaixo do mínimo de ` +
        `${env.AGENDA_INTERVALO_MIN_MINUTOS} min. Cada passada custa uma leitura de Sentença no RM, ` +
        'e com concurrency 1 o efeito é backlog crescente, não paralelismo',
    };
  }

  return {
    ok: true,
    cron,
    proximos: proximos.map((d) => emIso(d)),
    intervaloMinimoMinutos,
  };
}

/**
 * Menor intervalo observado na amostra de disparos, em minutos inteiros.
 *
 * Olha a amostra em vez de tentar interpretar a expressão: `0 3,3 * * *` e
 * `*\/1 * * * *` chegam ao mesmo lugar por caminhos diferentes, e a amostra
 * responde os dois. Arredonda para baixo, para a guarda nunca ser mais
 * permissiva que a realidade.
 */
function menorIntervaloEmMinutos(disparos: Date[]): number {
  let menor = Number.POSITIVE_INFINITY;
  for (let i = 1; i < disparos.length; i += 1) {
    const deltaMin = (disparos[i].getTime() - disparos[i - 1].getTime()) / 60_000;
    if (deltaMin < menor) menor = deltaMin;
  }
  return Number.isFinite(menor) ? Math.floor(menor) : Number.MAX_SAFE_INTEGER;
}

/** ISO 8601 com o offset de São Paulo, para a UI não reinterpretar no fuso dela. */
function emIso(d: Date): string {
  const partes = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ_AGENDA,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(d);
  // `sv-SE` formata como "2026-09-10 03:00:00", que é ISO a menos do separador.
  // O offset é fixo: o Brasil não tem horário de verão desde 2019, e o dia em que
  // voltar a ter, este literal é o lugar que precisa mudar (e o teste quebra).
  return `${partes.replace(' ', 'T')}-03:00`;
}

/** Só os próximos disparos, para quem já sabe que o cron é válido. */
export function proximosDisparos(cron: string, quantos = DISPAROS_NA_PREVIA, agora: Date = new Date()): string[] {
  const intervalo = parseExpression(cron, { tz: TZ_AGENDA, currentDate: agora });
  return Array.from({ length: quantos }, () => emIso(intervalo.next().toDate()));
}
