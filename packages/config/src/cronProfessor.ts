import { parseExpression } from 'cron-parser';
import { env } from './env';
import { TZ_AGENDA } from './cron';

/** Folga entre o sync de aluno e o de professor, em minutos. */
const FOLGA_MIN = 30;

/**
 * Folga abaixo da qual os dois syncs são considerados sobrepostos.
 *
 * O de aluno leva ~4 min e faz ~260 chamadas (medido em 31/07/2026). Dez minutos
 * é o menor número que ainda deixa o pior caso caber com margem. Entre 10 e 30 a
 * tela salva, mas avisa: 30 é a convenção medida, não um enfeite.
 */
const FOLGA_MINIMA_ACEITA_MIN = 10;

/** Quantos disparos comparar ao checar colisão. Cobre bem mais que um dia. */
const DISPAROS_COMPARADOS = 40;

/**
 * Cron do sync de professor derivado do de aluno, somando 30 minutos.
 *
 * ─── ATENÇÃO: ISTO DEIXOU DE SER A REGRA DE RUNTIME ─────────────────────────
 *
 * Até a tela de agendamento existir, esta função ERA a configuração do professor:
 * não havia variável própria, e o horário dele era calculado do horário do aluno
 * a cada registro de scheduler.
 *
 * Isso não sobrevive a uma tela. A derivação só entende `m h * * *` e
 * `m h1,h2 * * *`; qualquer outro formato cai no default `30 3 * * *` **em
 * silêncio** — comportamento defensável quando o valor vinha de um `.env` revisado
 * por quem deu deploy, e indefensável quando qualquer pessoa pode digitar um cron
 * na tela. O professor voltaria para 03:30 enquanto o aluno foi para outro
 * horário, e os dois passariam a disputar a janela de rate limit de 300s do
 * Toddle — o problema que a folga existe para evitar.
 *
 * Então a derivação virou DUAS coisas explícitas:
 *
 *   1. SEMENTE. Esta função continua sendo como a linha do professor nasce em
 *      `flow_schedule`, na primeira subida, a partir de `STUDENTS_SYNC_CRON`.
 *      Derivar uma vez, num valor que alguém revisou, é seguro.
 *   2. VALIDAÇÃO. `avaliarFolga()` abaixo é o que impede a tela de salvar um par
 *      de horários que colide. A folga passou de cálculo implícito a regra
 *      verificada — e a verificação vale para QUALQUER cron, não só para os dois
 *      formatos que a regex entende.
 *
 * Entende `m h * * *` E `m h1,h2,... * * *`; qualquer outro formato cai no
 * default, porque uma semente previsível é melhor que uma semente calculada
 * errado.
 *
 * ─── POR QUE MORA EM `config` E NÃO EM `queues` ─────────────────────────────
 *
 * É configuração derivada, não fila. E há uma razão prática: o `preflight` roda
 * no deploy e precisa desta função para dizer QUAL cron está sendo verificado.
 * Importar de `@rm-toddle/queues` puxava o index do pacote, que abre a conexão
 * Redis — e o preflight nunca encerrava, travando o deploy para sempre. Pior que
 * o bug que ele existe para evitar.
 */
export function cronDoProfessor(cronDoAluno: string): string {
  const m = /^(\d{1,2})\s+(\d{1,2}(?:\s*,\s*\d{1,2})*)\s+\*\s+\*\s+\*$/.exec(cronDoAluno.trim());
  if (!m) return `${FOLGA_MIN} 3 * * *`;

  const minuto = Number(m[1]);
  const horas = m[2].split(',').map((h) => Number(h.trim()));
  if (minuto > 59 || horas.some((h) => h > 23)) return `${FOLGA_MIN} 3 * * *`;

  const somado = minuto + FOLGA_MIN;
  const novoMinuto = somado % 60;
  // Se a soma passou da hora, cada hora da lista anda uma casa (23 -> 0).
  const carrega = somado >= 60 ? 1 : 0;
  const novasHoras = horas.map((h) => (h + carrega) % 24);

  return `${novoMinuto} ${novasHoras.join(',')} * * *`;
}

/**
 * O cron do professor derivado do AMBIENTE.
 *
 * @deprecated Só para SEMEAR a agenda e para o preflight relatar o que o
 * ambiente traz. O horário em vigor vem de `flow_schedule` — leia pelo
 * `scheduleRepository`, não por aqui, ou você relata um valor que não é o que vai
 * disparar.
 */
export function cronDoProfessorEfetivo(): string {
  return cronDoProfessor(env.STUDENTS_SYNC_CRON);
}

export interface FolgaAvaliada {
  /** `true` quando os dois disparam perto demais para não se atrapalharem. */
  colide: boolean;
  /** Menor distância observada entre um disparo de um e um do outro, em minutos. */
  menorFolgaMinutos: number;
  /** Preenchido quando `colide`: a mensagem que a tela mostra ao recusar. */
  motivo?: string;
  /** Preenchido quando passa, mas abaixo da convenção de 30 min. */
  aviso?: string;
}

/**
 * Os dois cronogramas se atrapalham?
 *
 * ─── O QUE ESTA FUNÇÃO PROTEGE ──────────────────────────────────────────────
 *
 * A janela de rate limit do Toddle é de 300s (ver docs/DECISOES.md), e os dois
 * syncs falam com a MESMA organização. O de aluno leva ~4 min e faz ~260
 * chamadas; sobrepor os dois é a receita para os dois falharem — e falharem por
 * 429, que é o erro que parece transitório e não é.
 *
 * ─── POR QUE COMPARA DISPAROS, E NÃO AS EXPRESSÕES ──────────────────────────
 *
 * Porque `0 3 * * *` e `0 3 * * 1-5` colidem só de segunda a sexta, e comparar
 * texto não vê isso. Expandir os próximos N disparos de cada um e medir a menor
 * distância responde para qualquer par de expressões, incluindo as que a regex da
 * derivação nunca entendeu.
 */
export function avaliarFolga(cronA: string, cronB: string, agora: Date = new Date()): FolgaAvaliada {
  const disparos = (cron: string): number[] => {
    const it = parseExpression(cron, { tz: TZ_AGENDA, currentDate: agora });
    return Array.from({ length: DISPAROS_COMPARADOS }, () => it.next().toDate().getTime());
  };

  const a = disparos(cronA);
  const b = disparos(cronB);

  let menor = Number.POSITIVE_INFINITY;
  for (const ta of a) {
    for (const tb of b) {
      const delta = Math.abs(ta - tb) / 60_000;
      if (delta < menor) menor = delta;
    }
  }
  const menorFolgaMinutos = Math.floor(menor);

  if (menorFolgaMinutos < FOLGA_MINIMA_ACEITA_MIN) {
    return {
      colide: true,
      menorFolgaMinutos,
      motivo:
        `os dois fluxos disparam a ${menorFolgaMinutos} min de distância, e o sync de aluno leva ~4 min ` +
        `fazendo ~260 chamadas. Sobrepostos, os dois competem pela janela de rate limit de 300s do Toddle ` +
        `e podem falhar juntos. Deixe ao menos ${FOLGA_MIN} min entre eles`,
    };
  }
  if (menorFolgaMinutos < FOLGA_MIN) {
    return {
      colide: false,
      menorFolgaMinutos,
      aviso:
        `folga de ${menorFolgaMinutos} min entre os dois fluxos. A convenção medida é ${FOLGA_MIN} min, ` +
        'que cobre o pior caso do sync de aluno com margem larga',
    };
  }
  return { colide: false, menorFolgaMinutos };
}
