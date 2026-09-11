/**
 * O progresso de um job, do jeito que dá para saber de verdade.
 *
 * ─── A REGRA: SÓ HÁ PORCENTAGEM QUANDO HÁ DENOMINADOR ───────────────────────
 *
 * Metade do trabalho destes jobs é LER — uma Sentença do RM, as páginas do
 * Toddle. Não existe "quanto falta" numa chamada SOAP em andamento: ou ela
 * voltou, ou não. Inventar um número ali (fingir 50% enquanto lê) é pior que não
 * mostrar nada, porque ensina a não confiar na barra.
 *
 * Então `feitos`/`total` são OPCIONAIS e vêm juntos ou não vêm. A tela mostra
 * barra quando os dois existem, e só o nome da fase quando não existem. É a
 * diferença entre "lendo o RM…" e "criando staff 12/37".
 *
 * ─── O PROGRESSO DE ALUNOS NÃO PASSA POR AQUI ───────────────────────────────
 *
 * O sync de aluno é fan-out: o job de extract termina depois de ENFILEIRAR os
 * lotes, e quem trabalha são os lotes, que são outros jobs. O progresso do run
 * inteiro já existe no Postgres desde antes deste arquivo — `lotesEsperados` no
 * payload e `lotesConcluidos` no resultado, incrementado atomicamente por cada
 * lote (`runRepository`). Ler de lá é mais verdadeiro que somar `job.progress`
 * de N jobs irmãos.
 */

export interface ProgressoDeJob {
  /** Rótulo legível da etapa. Sempre presente. Ex.: "lendo o RM". */
  fase: string;
  /** Quantos itens já foram processados NESTA fase. Só com `total`. */
  feitos?: number;
  /** Quantos itens a fase tem no total. Só com `feitos`. */
  total?: number;
}

/**
 * A fração, quando ela existe de verdade.
 *
 * Devolve `null` — e não `0` — quando não há denominador: zero desenharia uma
 * barra vazia, que é uma afirmação ("não começou"), e não a ausência de
 * afirmação que se quer ali.
 */
export function fracaoDoProgresso(p: ProgressoDeJob | null | undefined): number | null {
  if (!p || p.feitos === undefined || p.total === undefined) return null;
  if (!Number.isFinite(p.feitos) || !Number.isFinite(p.total) || p.total <= 0) return null;
  return Math.min(Math.max(p.feitos / p.total, 0), 1);
}

/** Type guard: o que o BullMQ devolve em `job.progress` é `unknown`. */
export function lerProgresso(bruto: unknown): ProgressoDeJob | null {
  if (typeof bruto !== 'object' || bruto === null) return null;
  const o = bruto as Record<string, unknown>;
  if (typeof o.fase !== 'string') return null;
  const feitos = typeof o.feitos === 'number' ? o.feitos : undefined;
  const total = typeof o.total === 'number' ? o.total : undefined;
  // Um sem o outro é ruído: descarta os dois em vez de mostrar "12/?".
  const par = feitos !== undefined && total !== undefined ? { feitos, total } : {};
  return { fase: o.fase, ...par };
}
