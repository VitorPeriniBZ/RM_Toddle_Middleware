import type { ProjetadoNota } from './gradeProjection';

/**
 * Monta o dataset `EduNotaEtapa` que o `SaveRecord` do `EduNotaEtapaData`
 * aceita. Gramática medida por `GetSchema` no RM em 09/09/2026 — o XSD está
 * versionado em docs/rm-dataservers/EduNotaEtapaData.xsd.
 *
 * Esta função só produz string. Quem envia é o `escreverNotas.ts`.
 *
 * ─── O DATASET DA NOTA NÃO TEM NAMESPACE. O DA FREQUÊNCIA TEM. ──────────────
 *
 * Medido, e é a diferença que mais facilmente passaria batida:
 *
 *   EduFrequenciaDiaria  targetNamespace="http://tempuri.org/EduFrequenciaDiaria.xsd"
 *   EduNotaEtapa         xmlns=""  — NENHUM targetNamespace
 *
 * Copiar o cabeçalho do XML da frequência e trocar o nome do elemento produziria
 * um dataset com namespace que o DataServer não declara. E o RM responde HTTP
 * 200 mesmo quando recusa, então o sintoma seria "escreveu e não apareceu".
 *
 * ─── NÃO HÁ `PARAMS`, E NÃO HÁ TABELA DE ALUNOS ─────────────────────────────
 *
 * O `EduFrequenciaDiaria` exige `PARAMS` (o recorte turma-disciplina + etapa) e
 * `AlunosFreq` (os RAs do dataset). O `EduNotaEtapa` não tem nem um nem outro:
 * cada linha `SNotaEtapa` já carrega a chave completa. Por isso um único dataset
 * pode conter notas de turmas-disciplina DIFERENTES — mas este módulo agrupa por
 * (IDTURMADISC, CODETAPA) de todo jeito, porque é o recorte em que o RM valida
 * etapa, e um lote misto transformaria uma recusa de etapa na recusa de todas.
 *
 * ─── `TIPOETAPA` É O CAMPO MAIS PERIGOSO DESTE ARQUIVO ──────────────────────
 *
 * `NOTAFALTA` é UM campo só, discriminado por `TIPOETAPA`: `'N'` é a nota da
 * etapa, `'F'` é o NÚMERO DE FALTAS. Mandar `'F'` por engano não erra uma nota —
 * grava um total de faltas, e o total de faltas alimenta o cálculo de reprovação
 * por frequência. Por isso o valor é constante neste módulo e não vem de
 * parâmetro: não existe caminho em que este arquivo escreva `'F'`.
 *
 * ─── `AULASDADAS`: OMITIDO, MAS COM O ECO PRONTO ────────────────────────────
 *
 * O XSD marca `minOccurs="0"`, e por isso a doc do DataServer concluía "omitir".
 * A frequência ensinou que opcional no XSD não é opcional na regra de negócio:
 * medido em 21/08/2026, o `SaveRecord` da frequência RECUSA sem o campo
 * ("O campo número de aulas dadas deve ser preenchido", em
 * `EduFrequenciaDiariaObj.ValidaEtapa`).
 *
 * Não sabemos se `EduNotaEtapaObj` valida igual — não houve `SaveRecord` de nota
 * ainda. O default aqui é OMITIR (é o que o XSD permite) e a capacidade de ecoar
 * está pronta: passe `aulasDadasDe` e o valor entra. Quando o primeiro
 * `SaveRecord` real acontecer, a resposta do RM decide qual dos dois é o certo —
 * e o valor ecoado é sempre o que o RM já tinha, nunca calculado, porque
 * administrar o denominador dos 75% mudaria quem reprova.
 */

function escapeXml(valor: string): string {
  return valor
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** `'N'` = nota. Constante por segurança — ver o cabeçalho. */
export const TIPOETAPA_NOTA = 'N';

/**
 * Formata a nota para o `NOTAFALTA` (`xs:decimal`).
 *
 * PONTO decimal, sempre. O RM é .NET com `UseCurrentLocale="true"` no dataset, e
 * um separador de vírgula num ambiente pt-BR seria interpretado — ou recusado —
 * de forma dependente de configuração de servidor. Número em XML não é texto
 * localizado.
 */
export function notaParaRm(valor: number): string {
  if (!Number.isFinite(valor)) {
    throw new Error(`notaParaRm: valor não finito (${valor})`);
  }
  // Sem casas desnecessárias: 7 vira "7", 6,5 vira "6.5". O RM guarda 4 decimais.
  return String(Number(valor.toFixed(4)));
}

export interface LoteNotas {
  idTurmaDisc: string;
  codEtapa: string;
  linhas: ProjetadoNota[];
  xml: string;
  /** O `AULASDADAS` ecoado, ou `null` quando o campo foi omitido. */
  aulasDadas: string | null;
}

/**
 * De onde vem o `AULASDADAS` a ecoar, por (IDTURMADISC, CODETAPA).
 *
 * É parâmetro, e não leitura feita aqui dentro, para esta função continuar pura —
 * e para o ensaio montar exatamente o mesmo XML que o writer enviaria. Ensaio que
 * mostra XML diferente do que seria enviado não é ensaio, é ficção.
 */
export type AulasDadasDeNota = (idTurmaDisc: string, codEtapa: string) => string | null;

/**
 * Agrupa os projetados em lotes por (IDTURMADISC, CODETAPA) e monta o XML de cada
 * um.
 *
 * Deduplica pela chave natural antes de montar. O dataset vem com
 * `EnforceConstraints="False"` — o mesmo do da frequência —, ou seja o RM NÃO
 * rejeita chave repetida, apesar de o XSD DECLARAR `xs:unique Constraint1` sobre
 * (CODCOLIGADA, CODETAPA, TIPOETAPA, IDTURMADISC, RA). Declarada e não aplicada:
 * a deduplicação é nossa.
 */
export function montaLotesNotas(
  projetados: ProjetadoNota[],
  aulasDadasDe?: AulasDadasDeNota,
): LoteNotas[] {
  const grupos = new Map<string, ProjetadoNota[]>();
  for (const p of projetados) {
    const chave = `${p.linha.idTurmaDisc}|${p.linha.codEtapa}`;
    const atual = grupos.get(chave);
    if (atual) atual.push(p);
    else grupos.set(chave, [p]);
  }

  const lotes: LoteNotas[] = [];

  for (const [chave, itens] of [...grupos.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [idTurmaDisc, codEtapa] = chave.split('|');

    const vistas = new Set<string>();
    const unicas: ProjetadoNota[] = [];
    for (const item of itens) {
      if (vistas.has(item.chaveRm)) continue;
      vistas.add(item.chaveRm);
      unicas.push(item);
    }

    const aulasDadas = aulasDadasDe?.(idTurmaDisc, codEtapa) ?? null;

    const partes: string[] = ['<?xml version="1.0" encoding="utf-8"?>', '<EduNotaEtapa>'];

    const ordenadas = [...unicas].sort((a, b) => a.linha.ra.localeCompare(b.linha.ra));
    for (const { linha } of ordenadas) {
      partes.push(
        '  <SNotaEtapa>',
        `    <CODCOLIGADA>${escapeXml(linha.codColigada)}</CODCOLIGADA>`,
        `    <CODETAPA>${escapeXml(linha.codEtapa)}</CODETAPA>`,
        `    <TIPOETAPA>${TIPOETAPA_NOTA}</TIPOETAPA>`,
        `    <IDTURMADISC>${escapeXml(linha.idTurmaDisc)}</IDTURMADISC>`,
        `    <RA>${escapeXml(linha.ra)}</RA>`,
        `    <NOTAFALTA>${escapeXml(linha.nota)}</NOTAFALTA>`,
        ...(aulasDadas ? [`    <AULASDADAS>${escapeXml(aulasDadas)}</AULASDADAS>`] : []),
        '  </SNotaEtapa>',
      );
    }

    partes.push('</EduNotaEtapa>');

    lotes.push({ idTurmaDisc, codEtapa, linhas: unicas, xml: partes.join('\n'), aulasDadas });
  }

  return lotes;
}
