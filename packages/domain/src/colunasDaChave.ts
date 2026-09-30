import type { ConsultaRow } from '@rm-toddle/integrations';

/**
 * COLUNA AUSENTE DO RESULT SET × VALOR VAZIO NUMA LINHA.
 *
 * ─── POR QUE ISTO É UMA FUNÇÃO SÓ, E NÃO UMA POR FONTE ──────────────────────
 *
 * O P0-6 escreveu esta lógica dentro de `rmAttendanceSource`. O P1-A precisou
 * da mesma coisa para `rmGradeSource`, e copiar seria repetir exatamente o
 * defeito que este projeto mais persegue: duas cópias de uma regra sutil, que
 * divergem no dia em que alguém melhora uma delas.
 *
 * É o mesmo raciocínio que fez `chaveNaturalDeFalta` CHAMAR `chaveNaturalRm`
 * em vez de reimplementá-la — e lá existe um teste estrutural só para garantir
 * que continue assim.
 *
 * ─── A DISTINÇÃO QUE O `?? ''` APAGAVA ─────────────────────────────────────
 *
 *   coluna ausente do RESULT SET  a Sentença mudou. Vale para TODAS as linhas.
 *                                 É drift, e o run inteiro está comprometido.
 *   valor vazio numa LINHA        aquele registro é que está incompleto. Vale
 *                                 para uma linha, e a reação é descartá-la.
 *
 * A distinção é observável e barata: olham-se as CHAVES do objeto de linha,
 * não os valores. Uma coluna que existe e vem nula continua existindo.
 */

/**
 * Quais das colunas exigidas NÃO existem no result set.
 *
 * `exigidas` é uma lista de VARIANTES por coluna — as mesmas que o `pick` de
 * cada fonte tenta, porque a Sentença pode declarar `IDTURMADISC` ou
 * `ID_TURMADISC` e as duas são a mesma coluna. O nome devolvido é o primeiro
 * da lista, que é o canônico.
 *
 * ─── A UNIÃO DE TODAS AS LINHAS, E NÃO A PRIMEIRA ──────────────────────────
 *
 * A primeira versão olhava só `rows[0]`, supondo schema fixo. Não há schema
 * fixo neste transporte: o dataset chega como XML `<NewDataSet><Resultado>…` e
 * a serialização do .NET OMITE o elemento quando o valor é DBNull —
 * `linhasDoDataset.test.ts` documenta um `<Resultado>` com um campo só.
 *
 * Com amostra de uma linha, dois erros simétricos:
 *   coluna nula na linha 0 e presente no resto  -> acusa drift que não existe
 *                                                  (em ESTRITO, aborta o run)
 *   coluna presente na 0 e nula na 400          -> não acusa drift que existe
 *
 * A união custa uma passada pelas linhas — ruído de perfil, não de relógio.
 * Uma coluna só é "ausente" quando falta em TODAS, que é a assinatura de a
 * Sentença ter deixado de declará-la.
 */
export function colunasAusentesNoResultSet(
  rows: readonly ConsultaRow[],
  exigidas: ReadonlyArray<readonly string[]>,
): string[] {
  // Sem linha nenhuma não há result set para inspecionar, e "janela sem
  // movimento" é estado legítimo — fim de semana, feriado, recesso. Acusar
  // drift aqui seria alerta toda segunda-feira de manhã sobre o domingo.
  if (rows.length === 0) return [];

  const presentes = new Set<string>();
  for (const row of rows) for (const k of Object.keys(row)) presentes.add(k.toLowerCase());

  return exigidas
    .filter((variantes) => !variantes.some((v) => presentes.has(v.toLowerCase())))
    .map((variantes) => variantes[0]);
}

/**
 * A frase que vai para o log e para o alerta quando uma coluna da chave some.
 *
 * Uma só, para que as duas fontes digam a mesma coisa: quem lê o alerta de
 * notas às 3h da manhã não deveria precisar aprender um vocabulário diferente
 * do que já leu no de frequência.
 */
export function explicarColunasAusentes(args: {
  fluxo: string;
  sentenca: string;
  ausentes: readonly string[];
}): string {
  return (
    `A Sentença ${args.sentenca} devolveu um result set SEM as colunas ` +
    `${args.ausentes.join(', ')}, que compõem a chave natural de ${args.fluxo}. Sem elas a ` +
    `chave sai com segmento vazio, não casa com nada, TUDO vira ESCREVER_NOVO e a proteção ` +
    `contra sobrescrever lançamento de professor fica desligada — sem erro e sem DLQ. ` +
    `Causa provável: cópia de base apagou a Sentença e o restauro automático recolocou uma ` +
    `versão do repositório mais antiga que a que estava no RM. Confira com ` +
    `\`npm run canario -- --executar\`.`
  );
}
