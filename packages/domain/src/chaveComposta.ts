/**
 * CHAVE COMPOSTA QUE RECUSA COMPONENTE QUE NÃO É VALOR.
 *
 * ─── O QUE ESTE MÓDULO EXISTE PARA IMPEDIR ─────────────────────────────────
 *
 * Um índice de `Map` cuja chave é montada por template literal aceita
 * qualquer coisa, inclusive o que não deveria existir:
 *
 *   `${row.IDTURMADISC}|${row.CODETAPA}`   com os campos ausentes
 *   -> "undefined|undefined"
 *
 * `DataServerRow` é `Record<string, string>`, e sem `noUncheckedIndexedAccess`
 * o índice MENTE: o TypeScript promete `string` para chave que não existe. Em
 * runtime sai `undefined`, que o template literal converte para a palavra
 * `"undefined"` — uma string não-vazia, plausível, que passa por qualquer
 * guarda de "está vazio?".
 *
 * ─── O QUE DECIDE SE ISSO VIRA DANO ────────────────────────────────────────
 *
 * Não é a chave. É como o CONSUMIDOR reage a não encontrar nada:
 *
 *   FALHA ABERTA   `provasPorEtapa.get(chave) ?? []` devolve lista vazia, e a
 *                  cadeia inteira desarma: `proximoCodProva` volta 1, a guarda
 *                  anti-duplicata por descrição fica vazia, e o sistema CRIA
 *                  uma avaliação que já existe — `CODPROVA` colidindo, no
 *                  registro acadêmico.
 *
 *   FAIL-SAFE      `ctx.etapasRm.get(chave)` sem default: `gradeProjection`
 *                  recusa com `ETAPA_NAO_GRAVAVEL` e a nota não é escrita.
 *
 * Os dois padrões conviviam no mesmo repositório, com a mesma classe de
 * defeito, e a diferença nunca esteve escrita em lugar nenhum. O segundo é
 * fail-safe POR ACIDENTE — propriedade que não sobrevive a um consumidor
 * futuro que resolva usar `?? algumCoisa`.
 *
 * Este módulo tira a decisão do consumidor: chave incompleta não chega a
 * existir.
 */

/**
 * Monta a chave, ou lança nomeando o componente que faltou.
 *
 * `rotulo` aparece na mensagem — é o que diz a quem lê o log QUAL índice
 * recusou, já que o mesmo formato `a|b` serve a vários.
 *
 * ─── O QUE CONTA COMO "NÃO É VALOR" ────────────────────────────────────────
 *
 *   undefined / null        campo ausente no result set
 *   string vazia            campo presente e vazio
 *   só espaço em branco     `!v` deixaria passar; `'   '` não é chave
 *   a string "undefined"    o que `String(undefined)` produz, e o caso mais
 *                           difícil de ver porque parece um valor
 *
 * `'0'` NÃO entra na lista: é string não-vazia e código legítimo no RM. Só o
 * NÚMERO zero é falsy, e aqui nunca se lida com número.
 */
export function chaveComposta(
  rotulo: string,
  partes: Readonly<Record<string, string | undefined | null>>,
): string {
  const nomes = Object.keys(partes);
  const ruim = nomes.find((k) => {
    const v = partes[k];
    if (v == null) return true;
    const s = String(v).trim();
    return s === '' || s === 'undefined';
  });

  if (ruim !== undefined) {
    throw new Error(
      `${rotulo}: componente "${ruim}" veio vazio ou ausente (${JSON.stringify(partes)}). ` +
        'Chave incompleta não casa com nada, e o que acontece depois disso depende de como ' +
        'quem consulta reage ao miss — no melhor caso a operação é recusada, no pior a ' +
        'ausência é lida como "não existe" e o sistema CRIA um registro duplicado no RM.',
    );
  }

  return nomes.map((k) => String(partes[k])).join('|');
}
