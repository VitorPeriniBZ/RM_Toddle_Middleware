/**
 * A forma canônica de uma nota, para COMPARAÇÃO.
 *
 * ─── O DEFEITO QUE ISTO CONSERTA ────────────────────────────────────────────
 *
 * O RM devolve `"9.0000"`; o Toddle devolve `9`, que viramos `"9"`. É o mesmo
 * número escrito por dois sistemas com convenções de precisão diferentes — mas
 * `hashValor` compara TEXTO, e os dois hashes nunca batiam. Consequência medida:
 *
 *   chave 1|6|2|N|1266|202600098   desejado "9"   no RM "9.0000"
 *   proveniência (escrita de 10/09) = sha256("9")
 *   decidirEscrita compara com sha256("9.0000")  →  nunca bate
 *
 * Ou seja, TODA nota já escrita por esta via virava `EDITADO_POR_FORA`
 * permanente — "alguém editou no RM depois de nós" — com o RM contendo
 * exatamente o que nós escrevemos, intacto. A pendência é falsa, e cada nova
 * passada a recriava.
 *
 * ─── POR QUE AQUI, E NÃO DENTRO DE `hashValor` ──────────────────────────────
 *
 * `hashValor` também compara conteúdo de aula e observação de frequência, que
 * são TEXTO. Ensinar aritmética àquela função faria `"9"` e `"9.0"` iguais num
 * campo de texto livre, onde a diferença pode ser real. O conhecimento numérico
 * pertence a quem lida com nota — e é aplicado nas DUAS pontas, na leitura do RM
 * e na montagem do desejado, para que a comparação seja simétrica.
 *
 * ─── SEPARADOR DECIMAL: OS DOIS, PORQUE O RM USA OS DOIS ────────────────────
 *
 * Na LEITURA o RM devolve ponto (`"9.0000"`). Na ESCRITA ele exige vírgula — e
 * ponto ali vira separador de milhar, defeito já medido neste projeto: `6.25`
 * foi gravado como 625. Então os dois são aceitos como decimal na entrada, e a
 * saída é uma só. Quem formata para o XML de escrita continua responsável por
 * pôr a vírgula de volta; isto aqui é comparação, não formatação.
 *
 * O que NÃO parece número passa intacto: a função não é um validador, e recusar
 * aqui esconderia o dado em vez de revelá-lo.
 */

/** Nota reconhecível: opcional sinal, dígitos, e no máximo UM separador. */
const SO_NUMERO = /^-?\d+(?:[.,]\d+)?$/;

/**
 * Casas decimais preservadas. O RM guarda 4 (`NOTA numeric(x,4)`), então
 * arredondar aqui nunca descarta precisão que exista do outro lado — e evita
 * que o ruído de ponto flutuante (`0.1 + 0.2`) invente diferença.
 */
const CASAS = 4;

export function canonizarNota(valor: string | number | null | undefined): string | null {
  if (valor === null || valor === undefined) return null;

  const texto = String(valor).trim();
  if (texto === '') return null;
  if (!SO_NUMERO.test(texto)) return texto;

  const n = Number(texto.replace(',', '.'));
  if (!Number.isFinite(n)) return texto;

  // `toFixed` e depois tira os zeros à direita: `"9.0000"` → `"9"`,
  // `"9.5000"` → `"9.5"`. `-0` vira `0`, senão `-0` e `0` teriam hashes
  // diferentes sendo a mesma nota.
  const fixo = (n === 0 ? 0 : n).toFixed(CASAS);
  return fixo.replace(/\.?0+$/, '') || '0';
}
