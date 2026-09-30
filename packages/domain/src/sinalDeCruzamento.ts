/**
 * O SINAL DE QUE A TRAVA DE ESCRITA SE DESLIGOU SOZINHA.
 *
 * ─── O QUE ISTO OBSERVA ─────────────────────────────────────────────────────
 *
 * `decidirEscrita` impede a integração de apagar lançamento de professor, e tem
 * 15 testes. Mas ela só funciona se o cruzamento casar a LINHA CERTA — e o
 * casamento depende da chave natural, que depende de colunas que vêm de uma
 * Sentença que mora DENTRO do RM e some a cada cópia de base.
 *
 * Quando a chave degrada, o modo de falha é o pior possível, e está escrito na
 * prosa do autor em `rmAttendanceSource.ts:305-317`:
 *
 *   "tudo aparece como ESCREVER_NOVO, a proteção contra sobrescrever
 *    lançamento humano SE DESLIGA EM SILÊNCIO, e o relatório fica bonito"
 *
 * Nenhuma exceção. Nenhum job vermelho. Nenhuma linha na DLQ. O run fecha
 * verde, com números que parecem bons.
 *
 * ─── POR QUE ESTE MÓDULO NÃO É UM LIMIAR DE PORCENTAGEM ─────────────────────
 *
 * A tentação é alertar quando `ESCREVER_NOVO` passa de X%. Não serve: numa
 * primeira execução de um fluxo, 100% de `ESCREVER_NOVO` é o CERTO — o RM está
 * vazio e tudo é novo mesmo. Um limiar de porcentagem confunde "primeira vez"
 * com "a trava desligou", que são o oposto um do outro.
 *
 * O discriminador não é a proporção: é a CONTRADIÇÃO entre dois números que já
 * existem no run.
 *
 *   "O RM tem 2.449 faltas, e ZERO delas casou com o que queremos escrever."
 *
 * Isso não tem leitura inocente. Se o RM tem dado e nada casa, ou a chave
 * quebrou, ou estamos olhando para o período errado. Nos dois casos ninguém
 * deveria estar escrevendo.
 *
 * ─── E O SEGUNDO SINAL, QUE A DISTRIBUIÇÃO SOZINHA NÃO PEGA ─────────────────
 *
 * Duas aulas do mesmo aluno no mesmo dia diferem só por `IDTURMADISC` e
 * `IDHORARIOTURMA` — exatamente as duas colunas que o `?? ''` degrada. Com as
 * duas ausentes elas colapsam na MESMA chave, e `indexaFaltasPorChave` descarta
 * uma: a linha SOME do índice.
 *
 * Nesse caso a distribuição de vereditos pode ficar com cara de normal, porque
 * as linhas que sobraram casam. O sinal é aritmético e independente:
 * quantas linhas foram lidas contra quantas chaves únicas elas produziram.
 *
 * ─── SEM I/O, DE PROPÓSITO ──────────────────────────────────────────────────
 *
 * Recebe os números já contados e devolve o veredito. É o que permite testar
 * "a trava desligou" sem RM, sem banco e sem rede — mesma escolha de
 * `decidirEscrita` e `avaliarVolume`.
 */

/** Vereditos que significam "achei esta linha no RM". Ver rmWriteDecision.ts. */
const VEREDITOS_DE_CASAMENTO = [
  'NADA_A_FAZER',
  'ATUALIZAR_NOSSO',
  'CONFLITO_HUMANO',
  'EDITADO_POR_FORA',
  'REMOCAO_PEDE_HUMANO',
] as const;

export interface EntradaDoSinal {
  /** Linhas lidas do RM na janela (antes de indexar). */
  lidasDoRm: number;
  /** Chaves únicas que essas linhas produziram. Menor que `lidasDoRm` = colisão. */
  chavesUnicasDoRm: number;
  /** Contagem por veredito, como `resumirDecisoes` já devolve. */
  porVeredito: Record<string, number>;
}

export type MotivoDoSinal = 'nada-casou' | 'colisao-de-chave';

export interface SinalDeCruzamento {
  /** `true` quando há motivo para ninguém escrever nada até alguém olhar. */
  suspeito: boolean;
  motivos: MotivoDoSinal[];
  /** Frase pronta para o alerta e para o log. Vazia quando não há suspeita. */
  porque: string;
  /** Quantas linhas o índice engoliu por colisão. 0 quando não houve. */
  linhasPerdidas: number;
  /** Quantas decisões encontraram a linha no RM. */
  casaram: number;
}

/**
 * Avalia. Puro.
 *
 * ─── AS DUAS PERGUNTAS ──────────────────────────────────────────────────────
 *
 * 1. O RM tem linha e NENHUMA casou?
 *    Exige `lidasDoRm > 0` — sem isso, "nada casou" é só "o RM está vazio", que
 *    é o estado legítimo de um fluxo novo ou de uma janela sem aula.
 *    Exige também que tenha havido decisão a tomar: zero decisões não é
 *    contradição, é dia sem movimento.
 *
 * 2. As linhas lidas produziram menos chaves do que deveriam?
 *    Uma linha por aula-aluno é a premissa da Sentença. Duas linhas colapsando
 *    numa chave significa que a chave perdeu poder de distinguir — e o índice
 *    silenciosamente ficou com uma delas.
 */
export function avaliarCruzamento(e: EntradaDoSinal): SinalDeCruzamento {
  const motivos: MotivoDoSinal[] = [];

  const casaram = VEREDITOS_DE_CASAMENTO.reduce(
    (soma, v) => soma + (e.porVeredito[v] ?? 0),
    0,
  );
  const totalDecidido = Object.values(e.porVeredito).reduce((a, b) => a + b, 0);

  if (e.lidasDoRm > 0 && totalDecidido > 0 && casaram === 0) {
    motivos.push('nada-casou');
  }

  const linhasPerdidas = Math.max(0, e.lidasDoRm - e.chavesUnicasDoRm);
  if (linhasPerdidas > 0) motivos.push('colisao-de-chave');

  return {
    suspeito: motivos.length > 0,
    motivos,
    linhasPerdidas,
    casaram,
    porque: explicar(motivos, e, casaram, linhasPerdidas),
  };
}

function explicar(
  motivos: MotivoDoSinal[],
  e: EntradaDoSinal,
  casaram: number,
  linhasPerdidas: number,
): string {
  if (motivos.length === 0) return '';

  const partes: string[] = [];
  if (motivos.includes('nada-casou')) {
    partes.push(
      `o RM tem ${e.lidasDoRm} linha(s) na janela e NENHUMA casou com o que seria escrito ` +
        `(${casaram} casamentos). Ou a chave natural degradou — coluna que sumiu da Sentença ` +
        `vira segmento vazio —, ou a janela está errada. Nos dois casos a proteção contra ` +
        `sobrescrever lançamento de professor está desligada agora`,
    );
  }
  if (motivos.includes('colisao-de-chave')) {
    partes.push(
      `${e.lidasDoRm} linha(s) lidas produziram só ${e.chavesUnicasDoRm} chave(s) únicas: ` +
        `${linhasPerdidas} sumiram do índice por colisão. Duas aulas do mesmo aluno no mesmo ` +
        `dia só se distinguem por IDTURMADISC e IDHORARIOTURMA, que são as colunas que o ` +
        `\`?? ''\` degrada`,
    );
  }
  return partes.join('. ');
}

/**
 * O assunto do alerta. ESTÁVEL, por contrato do P0-2.
 *
 * Nada de número aqui: contagem muda a cada passada, e assunto que muda é
 * supressão que nunca acontece. Os números vão no contexto.
 *
 * O motivo entra porque são diagnósticos distintos: "nada casou" manda olhar a
 * Sentença e a janela; "colisão" manda olhar as colunas da chave.
 */
export function assuntoDoSinal(fluxo: string, motivo: MotivoDoSinal): string {
  const porMotivo: Record<MotivoDoSinal, string> = {
    'nada-casou': 'o RM tem dados e nada casou — a trava de escrita pode estar desligada',
    'colisao-de-chave': 'linhas do RM colidiram na mesma chave e sumiram do índice',
  };
  return `${fluxo}: ${porMotivo[motivo]}`;
}
