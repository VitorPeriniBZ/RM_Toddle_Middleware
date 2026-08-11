import { env } from './env';

/** Folga entre o sync de aluno e o de professor, em minutos. */
const FOLGA_MIN = 30;

/**
 * Cron do sync de professor, derivado do de aluno somando 30 minutos, para os
 * dois NÃO caírem no mesmo instante.
 *
 * A razão é medida, não estética: a janela de rate limit do Toddle é de 300s
 * (ver DECISOES.md), e os dois syncs falam com a mesma organização. O de aluno
 * leva ~4 min e faz ~260 chamadas; sobrepor os dois é a receita para os dois
 * falharem. 30 min cobre o pior caso do de aluno com margem larga.
 *
 * Entende `m h * * *` E `m h1,h2,... * * *` — a segunda forma existe porque o
 * sync roda 4× ao dia (03:00, 09:00, 12:00, 16:00). Antes só a primeira era
 * aceita, e um cron com lista de horas cairia no default, quebrando o
 * escalonamento EM SILÊNCIO.
 *
 * Qualquer outro formato cai no default: melhor um horário previsível que um
 * cron calculado errado sem ninguém notar.
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

/** O cron efetivo do professor neste ambiente, para log e diagnóstico. */
export function cronDoProfessorEfetivo(): string {
  return cronDoProfessor(env.STUDENTS_SYNC_CRON);
}
