import type { Projetado } from './attendanceProjection';

/**
 * Monta o dataset `EduFrequenciaDiaria` que o `SaveRecord` do
 * `EduFrequenciaDiariaWSData` aceita. Gramática medida por `GetSchema` em
 * 04/08/2026 — ver docs/rm-dataservers/EduFrequenciaDiariaWSData.md e o XSD ao
 * lado dele.
 *
 * Esta função só produz string. Quem envia é o `escreverFrequencia.ts`.
 *
 * ─── `AULASDADAS`: A OMISSÃO QUE O RM RECUSOU ───────────────────────────────
 *
 * Esta doc dizia, até 21/08/2026, que `AULASDADAS` NÃO era enviado — o campo é
 * `minOccurs=0` no XSD, é o denominador dos 75% de reprovação por falta, e
 * administrar número de aulas dadas não é papel de integração. O raciocínio
 * estava certo; a conclusão, errada.
 *
 * MEDIDO: o `SaveRecord` recusa o dataset sem o campo, com "O campo número de
 * aulas dadas deve ser preenchido" (`EduFrequenciaDiariaObj.ValidaEtapa`).
 * Opcional no XSD não é opcional na regra de negócio.
 *
 * A saída preserva a intenção original: o valor é **ecoado** do próprio RM, lido
 * de `SEtapas.AULASDADAS` na mesma execução, e **nunca calculado**. A integração
 * devolve ao RM o número que o RM já tinha, e por isso não muda quem reprova.
 *
 * Quando não há valor a ecoar, o lote sai com `aulasDadas: null` e quem escreve
 * deve RECUSAR — omitir o campo só transferiria a recusa para o RM, mais tarde e
 * com mensagem pior.
 *
 * Outras omissões, essas mantidas:
 *
 *  - `CODSUBTURMA` (opcional) NÃO é enviado: não existe subturma na coligada.
 *  - `PlanoAulaFreq` inteiro NÃO é enviado: todos os campos são opcionais e nada
 *    do que precisamos está lá.
 */

const NS = 'http://tempuri.org/EduFrequenciaDiaria.xsd';

function escapeXml(valor: string): string {
  return valor
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * "2026-03-02" → "2026-03-02T00:00:00".
 *
 * SEM `Z` e SEM offset, porque o schema declara
 * `msdata:DateTimeMode="Unspecified"`. Não é preciosismo: horas de deslocamento
 * movem a data, e a data é a entrada de DUAS resoluções — o dia da semana (que
 * define o IDHORARIOTURMA) e a janela da etapa (que define o CODETAPA). Um erro
 * de fuso aqui não erra o horário, erra a aula.
 */
export function dataRmSemFuso(dataIso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataIso)) {
    throw new Error(`dataRmSemFuso: esperava "YYYY-MM-DD", recebeu ${JSON.stringify(dataIso)}`);
  }
  return `${dataIso}T00:00:00`;
}

export interface LoteFrequencia {
  idTurmaDisc: string;
  codEtapa: string;
  /** RAs distintos que entram no AlunosFreq. */
  ras: string[];
  linhas: Projetado[];
  xml: string;
  /**
   * O `AULASDADAS` ecoado neste dataset, ou `null` quando não havia o que ecoar.
   *
   * `null` NÃO é "tudo bem, omitimos": é lote inescrevível. Quem envia checa
   * isto antes do `SaveRecord`.
   */
  aulasDadas: string | null;
}

/**
 * De onde vem o `AULASDADAS` a ecoar, por (IDTURMADISC, CODETAPA).
 *
 * É parâmetro, e não leitura feita aqui dentro, para esta função continuar pura
 * — e para o shadow poder montar exatamente o mesmo XML que o writer enviaria.
 * Shadow que mostra XML diferente do que seria enviado não é ensaio, é ficção.
 */
export type AulasDadasDe = (idTurmaDisc: string, codEtapa: string) => string | null;

/**
 * Agrupa os projetados em lotes por (IDTURMADISC, CODETAPA) — que é o recorte do
 * `PARAMS`, um por dataset — e monta o XML de cada um.
 *
 * Deduplica pela chave natural do RM antes de montar. O dataset vem com
 * `EnforceConstraints="False"`, ou seja, o RM NÃO rejeita PK repetida; se duas
 * linhas iguais passarem, o comportamento é indefinido. A checagem de colisão
 * entre registros DIFERENTES do Toddle é separada, em `projetaLote`, e vai para
 * revisão em vez de ser resolvida aqui.
 */
export function montaLotes(
  projetados: Projetado[],
  aulasDadasDe?: AulasDadasDe,
): LoteFrequencia[] {
  const grupos = new Map<string, Projetado[]>();

  for (const p of projetados) {
    const chave = `${p.linha.idTurmaDisc}|${p.codEtapa}`;
    const atual = grupos.get(chave);
    if (atual) atual.push(p);
    else grupos.set(chave, [p]);
  }

  const lotes: LoteFrequencia[] = [];

  for (const [chave, itens] of [...grupos.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [idTurmaDisc, codEtapa] = chave.split('|');

    const vistas = new Set<string>();
    const unicas: Projetado[] = [];
    for (const item of itens) {
      if (vistas.has(item.chaveRm)) continue;
      vistas.add(item.chaveRm);
      unicas.push(item);
    }

    const ras = [...new Set(unicas.map((u) => u.linha.ra))].sort();
    const codColigada = unicas[0].linha.codColigada;

    const aulasDadas = aulasDadasDe?.(idTurmaDisc, codEtapa) ?? null;

    const partes: string[] = [
      '<?xml version="1.0" encoding="utf-8"?>',
      `<EduFrequenciaDiaria xmlns="${NS}">`,
      '  <PARAMS>',
      `    <CODCOLIGADA>${codColigada}</CODCOLIGADA>`,
      `    <IDTURMADISC>${escapeXml(idTurmaDisc)}</IDTURMADISC>`,
      `    <CODETAPA>${escapeXml(codEtapa)}</CODETAPA>`,
      // Ecoado do RM, nunca calculado. Ver o cabeçalho deste arquivo.
      ...(aulasDadas ? [`    <AULASDADAS>${escapeXml(aulasDadas)}</AULASDADAS>`] : []),
      '  </PARAMS>',
    ];

    for (const ra of ras) {
      partes.push(
        '  <AlunosFreq>',
        `    <CODCOLIGADA>${codColigada}</CODCOLIGADA>`,
        `    <RA>${escapeXml(ra)}</RA>`,
        `    <IDTURMADISC>${escapeXml(idTurmaDisc)}</IDTURMADISC>`,
        '  </AlunosFreq>',
      );
    }

    const ordenadas = [...unicas].sort((a, b) =>
      a.linha.data === b.linha.data
        ? a.linha.ra.localeCompare(b.linha.ra)
        : a.linha.data.localeCompare(b.linha.data),
    );

    for (const { linha } of ordenadas) {
      partes.push(
        '  <SFREQUENCIA>',
        `    <CODCOLIGADA>${linha.codColigada}</CODCOLIGADA>`,
        `    <IDHORARIOTURMA>${escapeXml(linha.idHorarioTurma)}</IDHORARIOTURMA>`,
        `    <IDTURMADISC>${escapeXml(linha.idTurmaDisc)}</IDTURMADISC>`,
        `    <RA>${escapeXml(linha.ra)}</RA>`,
        `    <DATA>${dataRmSemFuso(linha.data)}</DATA>`,
        `    <PRESENCA>${escapeXml(linha.presenca)}</PRESENCA>`,
        ...(linha.justificada ? [`    <JUSTIFICADA>${escapeXml(linha.justificada)}</JUSTIFICADA>`] : []),
        '  </SFREQUENCIA>',
      );
    }

    partes.push('</EduFrequenciaDiaria>');

    lotes.push({
      idTurmaDisc,
      codEtapa,
      ras,
      linhas: unicas,
      xml: partes.join('\n'),
      aulasDadas,
    });
  }

  return lotes;
}
