/**
 * A chave de negócio da turma-disciplina no de-para `COURSE`.
 *
 * ─── POR QUE O IDTURMADISC NÃO SERVIA ───────────────────────────────────────
 *
 * O `id_mapping` foi desenhado com `rm_code` = código de NEGÓCIO (RA, CHAPA,
 * CODTURMA) justamente para sobreviver a uma cópia de base. `COURSE` era a
 * exceção: usava `IDTURMADISC`, que é coluna *identity* do SQL Server. Toda
 * cópia de produção sobre o dev **renumera**, e aí há dois desfechos:
 *
 *   1. o número antigo não existe mais  → a turma parece nova, o sync cria
 *      duplicata no Toddle. Barulhento, alguém vê.
 *   2. o número antigo passou a pertencer a OUTRA turma-disciplina → o de-para
 *      aponta para a disciplina errada, sem erro nenhum, e frequência e nota
 *      vão para a turma errada. Silencioso, e por isso o motivo desta mudança.
 *
 * ─── POR QUE O PERÍODO LETIVO ENTRA NA CHAVE ────────────────────────────────
 *
 * `CODTURMA` não carrega o ano (`EAVES01IA` é o mesmo código em 2026 e 2027).
 * Medido em 11/09/2026 sobre as 392 turma-disciplina do RM: `CODTURMA:CODDISC`
 * é único DENTRO de um período letivo — zero colisões. Sem o período, a turma
 * de 2027 colidiria com a de 2026 na constraint `id_mapping_rm_uq`, e o de-para
 * do ano novo apontaria para o curso do ano velho.
 *
 * O `IDTURMADISC` não tinha esse problema (identity é global), então o período
 * é o que se paga por trocar surrogate por chave natural. É um bom negócio: a
 * colisão de ano é determinística e testável, a renumeração não.
 *
 * A chave composta segue o precedente do `ASSESSMENT`
 * (`IDTURMADISC:CODETAPA:CODPROVA`) — mesmo separador, mesma ideia.
 */

/** Separador das partes. Nenhum código do RM contém `:`. */
export const SEPARADOR_CHAVE = ':';

/**
 * Monta o `rm_code` de um `COURSE`.
 *
 * Lança se qualquer parte vier vazia: uma chave com buraco (`2026::ES26001`)
 * casaria com outra igualmente furada e uniria duas turmas diferentes no mesmo
 * registro do Toddle. Falhar aqui é barulhento; deixar passar, não.
 */
export function chaveCourse(periodoLetivo: string, codTurma: string, codDisc: string): string {
  const partes = [periodoLetivo, codTurma, codDisc].map((p) => (p ?? '').trim());
  const vazia = partes.findIndex((p) => p === '');
  if (vazia >= 0) {
    const nomes = ['periodoLetivo', 'codTurma', 'codDisc'];
    throw new Error(
      `chaveCourse: "${nomes[vazia]}" veio vazio (${JSON.stringify({ periodoLetivo, codTurma, codDisc })}). ` +
        'Chave incompleta uniria turmas distintas no mesmo mapeamento.',
    );
  }
  if (partes.some((p) => p.includes(SEPARADOR_CHAVE))) {
    throw new Error(
      `chaveCourse: alguma parte contém "${SEPARADOR_CHAVE}", o que torna a chave ambígua: ` +
        JSON.stringify({ periodoLetivo, codTurma, codDisc }),
    );
  }
  return partes.join(SEPARADOR_CHAVE);
}

/**
 * Reconhece um `rm_code` no formato antigo (só o `IDTURMADISC`).
 *
 * Serve para a migração ser idempotente e para o diagnóstico acusar base que
 * ficou pela metade. `IDTURMADISC` é inteiro; a chave nova sempre tem `:`.
 */
export function pareceChaveLegada(rmCode: string): boolean {
  return /^\d+$/.test(rmCode.trim());
}

/** Desmonta a chave nova. Devolve `null` se não for uma. */
export function lerChaveCourse(
  rmCode: string,
): { periodoLetivo: string; codTurma: string; codDisc: string } | null {
  const partes = rmCode.split(SEPARADOR_CHAVE);
  if (partes.length !== 3 || partes.some((p) => p.trim() === '')) return null;
  const [periodoLetivo, codTurma, codDisc] = partes;
  return { periodoLetivo, codTurma, codDisc };
}
