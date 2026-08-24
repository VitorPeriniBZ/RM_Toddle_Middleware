/**
 * Teto de volume: a última guarda antes de a escrita no RM existir.
 *
 * ─── A CLASSE DE FALHA QUE ISTO PEGA ────────────────────────────────────────
 *
 * As guardas anteriores são por REGISTRO. `decidirEscrita` olha uma linha e
 * pergunta "posso escrever esta?" — e faz isso bem. Mas ela é cega para a única
 * pergunta que importa quando o defeito é estrutural: **quantas?**
 *
 * Um `JOIN` errado no de-para virando produto cartesiano, ou um período letivo
 * divergente fazendo tudo parecer "faltando no RM", produz milhares de decisões
 * individualmente válidas. Cada uma passa em `ESCREVER_NOVO` com razão — o
 * registro realmente não está no RM. O erro só é visível no agregado.
 *
 * Então esta guarda não olha linha nenhuma. Olha o tamanho do plano e o compara
 * com o que a história diz ser normal.
 *
 * ─── SEM I/O, COMO A DECISÃO ────────────────────────────────────────────────
 *
 * Recebe os números e devolve o veredito. O writer lê o histórico e o escopo;
 * aqui só entra aritmética, para poder ser exercitada sem RM e sem banco.
 */

export type VeredictoVolume =
  /** Dentro do normal. Segue sem interrupção. */
  | 'AUTORIZADO'
  /** Fora do normal, mas plausível. Um humano confirma e o run recomeça. */
  | 'PRECISA_APROVACAO'
  /**
   * Absurdo. Nem aprovação resolve.
   *
   * Acima do teto absoluto, o número é a própria evidência do defeito — e um
   * humano clicando "aprovar" em 50.000 linhas não está dando consentimento
   * informado, está dando consentimento cansado. Conserte a causa, ou suba o
   * teto de propósito, o que é uma decisão visível.
   */
  | 'RECUSADO';

export interface PlanoDeEscrita {
  /** Linhas que o plano quer escrever no RM. */
  aEscrever: number;
  /** Total de linhas em escopo nesta janela — a base do percentual. */
  emEscopo: number;
  /**
   * Quantas linhas os runs anteriores escreveram, tipicamente. `null` = nunca
   * escrevemos — e a primeira escrita da vida SEMPRE passa por humano.
   */
  historico: number | null;
}

export interface LimitesDeVolume {
  /** Acima disto: `RECUSADO`. */
  tetoAbsoluto: number;
  /** Percentual acima do histórico que dispara aprovação. */
  desvioMaxPct: number;
  /** Percentual do escopo que, sozinho, dispara aprovação. */
  tetoEscopoPct: number;
  /**
   * Abaixo disto, não pede aprovação — mesmo fora do desvio.
   *
   * Existe porque percentual sobre número pequeno é ruído: sair de 2 para 6
   * linhas é +200% e não significa nada. Sem o piso, correção miúda viraria
   * pedido de aprovação, e aprovação que aparece por nada é aprovação que
   * alguém passa a dar sem ler.
   */
  pisoSemAprovacao: number;
}

export interface AvaliacaoVolume {
  veredito: VeredictoVolume;
  /** Todos os motivos que se aplicam, não só o primeiro. */
  motivos: string[];
  aEscrever: number;
  /** Percentual do escopo que o plano quer tocar. `null` se o escopo é 0. */
  pctDoEscopo: number | null;
  /** Percentual acima do histórico. `null` sem histórico ou histórico 0. */
  pctSobreHistorico: number | null;
}

const pct = (parte: number, todo: number): number | null =>
  todo > 0 ? Number(((parte / todo) * 100).toFixed(1)) : null;

/**
 * Avalia o plano.
 *
 * A ordem é: recusa absoluta primeiro, depois os gatilhos de aprovação, depois
 * autorizado. Os motivos são ACUMULADOS de propósito — saber que o plano estourou
 * o desvio *e* o percentual de escopo ao mesmo tempo é informação diferente de
 * saber que estourou um só, e quem aprova precisa disso.
 */
export function avaliarVolume(
  plano: PlanoDeEscrita,
  limites: LimitesDeVolume,
): AvaliacaoVolume {
  const { aEscrever, emEscopo, historico } = plano;
  const pctDoEscopo = pct(aEscrever, emEscopo);
  const pctSobreHistorico =
    historico !== null && historico > 0
      ? Number((((aEscrever - historico) / historico) * 100).toFixed(1))
      : null;

  const base = { aEscrever, pctDoEscopo, pctSobreHistorico };

  // Nada a escrever não é evento. Vale antes de tudo: um plano vazio não pode
  // ficar preso esperando aprovação, senão o cron para de rodar sozinho.
  if (aEscrever === 0) {
    return { ...base, veredito: 'AUTORIZADO', motivos: ['nada a escrever'] };
  }

  if (aEscrever > limites.tetoAbsoluto) {
    return {
      ...base,
      veredito: 'RECUSADO',
      motivos: [
        `${aEscrever} linhas excede o teto absoluto de ${limites.tetoAbsoluto}. ` +
          'Um plano deste tamanho é evidência de defeito estrutural (de-para em ' +
          'produto cartesiano, período letivo divergente), não de um dia movimentado. ' +
          'Investigue a causa ou suba WRITE_TETO_ABSOLUTO de propósito',
      ],
    };
  }

  const motivos: string[] = [];

  // A primeira escrita da vida passa por humano, independentemente do tamanho.
  // É o único run em que ninguém ainda viu o writer tocar o RM.
  if (historico === null) {
    motivos.push(
      'nenhuma escrita anterior registrada — a primeira vez que o writer toca o RM ' +
        'passa por confirmação humana, qualquer que seja o volume',
    );
  }

  const abaixoDoPiso = aEscrever <= limites.pisoSemAprovacao;

  if (
    historico !== null &&
    pctSobreHistorico !== null &&
    pctSobreHistorico > limites.desvioMaxPct &&
    !abaixoDoPiso
  ) {
    motivos.push(
      `${aEscrever} linhas está ${pctSobreHistorico}% acima do histórico de ${historico} ` +
        `(teto de desvio: ${limites.desvioMaxPct}%)`,
    );
  }

  if (pctDoEscopo !== null && pctDoEscopo > limites.tetoEscopoPct && !abaixoDoPiso) {
    motivos.push(
      `o plano toca ${pctDoEscopo}% do escopo desta janela (${aEscrever} de ${emEscopo}), ` +
        `acima do teto de ${limites.tetoEscopoPct}%`,
    );
  }

  if (motivos.length > 0) return { ...base, veredito: 'PRECISA_APROVACAO', motivos };

  return {
    ...base,
    veredito: 'AUTORIZADO',
    motivos: [
      historico !== null
        ? `${aEscrever} linhas, dentro do normal (histórico ${historico})`
        : `${aEscrever} linhas`,
    ],
  };
}
