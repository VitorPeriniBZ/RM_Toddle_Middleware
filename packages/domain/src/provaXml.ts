/**
 * Monta os datasets `EduProvas` e `EduNotas` que os `SaveRecord` dos
 * DataServers `EduProvasData` e `EduNotasData` aceitam. Gramática medida por
 * `GetSchema` em 09/09/2026.
 *
 * ─── NENHUM DOS DOIS TEM NAMESPACE ──────────────────────────────────────────
 *
 * Igual ao `EduNotaEtapa` e diferente do `EduFrequenciaDiaria`, que declara
 * `targetNamespace="http://tempuri.org/EduFrequenciaDiaria.xsd"`. Os dois novos
 * vêm com `xmlns=""`. Copiar o cabeçalho do XML de frequência produziria um
 * dataset que o DataServer não declara — e o RM responde HTTP 200 mesmo quando
 * recusa.
 *
 * ─── E OS DOIS VÊM COM `EnforceConstraints="False"` ─────────────────────────
 *
 * As chaves são declaradas (`xs:unique`) e não são aplicadas. A deduplicação é
 * nossa, aqui.
 *
 * ─── POR QUE ESTES DOIS DATASERVERS, E NÃO O DA NOTA DE ETAPA ───────────────
 *
 * Porque o da etapa não escreve. Medido: `EduNotaEtapaData` aceita o dataset,
 * responde `ok=true` e DESCARTA o `NOTAFALTA` — seis formatos testados, todos
 * com releitura `0.0000`. A nota da etapa é calculada por fórmula
 * (`SETAPAS.CODFORMULANOTA='01_ETAPA'`). A nota que se escreve é a da
 * avaliação.
 */

import { TIPOETAPA_NOTA } from './notaXml';

function escapeXml(valor: string): string {
  return valor
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// `TIPOETAPA_NOTA` ('N') vive em notaXml.ts e é importado, não redeclarado: o
// discriminador é o MESMO nas três tabelas (SNOTAETAPA, SProvas, SNotas), e duas
// constantes com o mesmo nome permitiriam divergir — sendo que 'F' gravaria
// FALTA em qualquer uma delas.
export { TIPOETAPA_NOTA } from './notaXml';

/**
 * Formata decimal para o RM. **VÍRGULA**, e isto foi medido do jeito difícil.
 *
 * ─── O QUE ACONTECEU COM O PONTO ────────────────────────────────────────────
 *
 * Enviando `<NOTA>6.25</NOTA>` numa prova de `VALOR=10`, o RM recusou o dataset
 * inteiro com:
 *
 *   "Aluno: 202100137 — A nota informada excede o valor máximo permitido para
 *    esta prova, que é de 10,0000 pontos"
 *
 * 6,25 não excede 10. O RM leu `6.25` como **625** — o ponto é separador de
 * MILHAR no locale pt-BR do servidor, e o dataset declara
 * `msdata:UseCurrentLocale="true"`. A própria mensagem de erro entrega a
 * convenção: ela escreve o máximo como `10,0000`.
 *
 * Era o oposto do que este arquivo afirmava antes ("ponto, sempre; número em XML
 * não é texto localizado"). Com `UseCurrentLocale`, é.
 *
 * ─── POR QUE ISSO É PERIGOSO E NÃO SÓ CHATO ─────────────────────────────────
 *
 * Só a nota de 6,25 (e a de 8,5) estourou o máximo. Se a prova valesse 1.000
 * pontos, `6.25` viraria 625 SEM estourar nada — e a nota do aluno ficaria
 * cem vezes maior, aceita em silêncio. O erro só apareceu porque o máximo era
 * pequeno. É sorte, não proteção.
 *
 * ─── SE UMA INSTALAÇÃO USAR LOCALE DIFERENTE ────────────────────────────────
 *
 * O separador vive nesta função e em nenhum outro lugar. Um RM em locale en-US
 * precisaria de ponto, e a troca é aqui — com um teste que reproduza o erro
 * acima, não por dedução.
 */
export function decimalParaRm(valor: number): string {
  if (!Number.isFinite(valor)) throw new Error(`decimalParaRm: valor não finito (${valor})`);
  return String(Number(valor.toFixed(4))).replace('.', ',');
}

/** A avaliação a criar no RM. */
export interface ProvaParaCriar {
  codColigada: string;
  idTurmaDisc: string;
  codEtapa: string;
  codProva: string;
  descricao: string;
  /**
   * `SProvas.VALOR` — quanto a avaliação vale.
   *
   * Recebe o `maxScore` do Toddle, e isso é uma DECISÃO com consequência: as
   * provas que a escola já tem valem `7.0000` (medido em duas turmas), enquanto
   * o assignment medido vale 10. Preservar o máximo do Toddle mantém a nota do
   * professor intacta e deixa a proporção para a fórmula do RM; forçar 7 exigiria
   * converter (8,5 de 10 → 5,95), o que é decisão pedagógica da escola e não
   * pertence a um montador de XML. Ver docs/levantamento-nota-por-avaliacao.md.
   */
  valor: number;
}

/** A nota de um aluno numa avaliação. */
export interface NotaParaEscrever {
  codColigada: string;
  codProva: string;
  codEtapa: string;
  idTurmaDisc: string;
  ra: string;
  nota: number;
}

/** `EduProvas` com UMA avaliação. Um dataset por avaliação: o RM valida etapa. */
export function montaXmlProva(p: ProvaParaCriar): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<EduProvas>',
    '  <SProvas>',
    `    <CODCOLIGADA>${escapeXml(p.codColigada)}</CODCOLIGADA>`,
    `    <IDTURMADISC>${escapeXml(p.idTurmaDisc)}</IDTURMADISC>`,
    `    <CODETAPA>${escapeXml(p.codEtapa)}</CODETAPA>`,
    `    <TIPOETAPA>${TIPOETAPA_NOTA}</TIPOETAPA>`,
    `    <CODPROVA>${escapeXml(p.codProva)}</CODPROVA>`,
    // maxLength 100 no XSD. Truncar aqui é melhor que o RM recusar o dataset.
    `    <DESCRICAO>${escapeXml(p.descricao.slice(0, 100))}</DESCRICAO>`,
    `    <VALOR>${decimalParaRm(p.valor)}</VALOR>`,
    '  </SProvas>',
    '</EduProvas>',
  ].join('\n');
}

export interface LoteNotasAvaliacao {
  idTurmaDisc: string;
  codEtapa: string;
  codProva: string;
  linhas: NotaParaEscrever[];
  xml: string;
}

/**
 * Agrupa as notas por (IDTURMADISC, CODETAPA, CODPROVA) — o recorte de UMA
 * avaliação — e monta um `EduNotas` para cada.
 *
 * Um dataset misto seria aceito pelo schema, mas transformaria a recusa de uma
 * avaliação na recusa de todas. Deduplica pela chave natural antes de montar,
 * porque `EnforceConstraints="False"`.
 */
export function montaLotesNotasAvaliacao(notas: NotaParaEscrever[]): LoteNotasAvaliacao[] {
  const grupos = new Map<string, NotaParaEscrever[]>();
  for (const n of notas) {
    const chave = `${n.idTurmaDisc}|${n.codEtapa}|${n.codProva}`;
    const atual = grupos.get(chave);
    if (atual) atual.push(n);
    else grupos.set(chave, [n]);
  }

  const lotes: LoteNotasAvaliacao[] = [];
  for (const [chave, itens] of [...grupos.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [idTurmaDisc, codEtapa, codProva] = chave.split('|');

    const vistas = new Set<string>();
    const unicas: NotaParaEscrever[] = [];
    for (const n of itens) {
      if (vistas.has(n.ra)) continue;
      vistas.add(n.ra);
      unicas.push(n);
    }
    unicas.sort((a, b) => a.ra.localeCompare(b.ra));

    const partes = ['<?xml version="1.0" encoding="utf-8"?>', '<EduNotas>'];
    for (const n of unicas) {
      partes.push(
        '  <SNotas>',
        `    <CODCOLIGADA>${escapeXml(n.codColigada)}</CODCOLIGADA>`,
        `    <CODPROVA>${escapeXml(n.codProva)}</CODPROVA>`,
        `    <CODETAPA>${escapeXml(n.codEtapa)}</CODETAPA>`,
        `    <TIPOETAPA>${TIPOETAPA_NOTA}</TIPOETAPA>`,
        `    <IDTURMADISC>${escapeXml(n.idTurmaDisc)}</IDTURMADISC>`,
        `    <RA>${escapeXml(n.ra)}</RA>`,
        `    <NOTA>${decimalParaRm(n.nota)}</NOTA>`,
        '  </SNotas>',
      );
    }
    partes.push('</EduNotas>');

    lotes.push({ idTurmaDisc, codEtapa, codProva, linhas: unicas, xml: partes.join('\n') });
  }
  return lotes;
}

/**
 * Chave natural da nota de avaliação no RM, na ORDEM do `xs:unique` do XSD:
 * CODCOLIGADA, CODPROVA, CODETAPA, TIPOETAPA, IDTURMADISC, RA.
 */
export const chaveNaturalNotaAvaliacao = (n: {
  codColigada: string;
  codProva: string;
  codEtapa: string;
  idTurmaDisc: string;
  ra: string;
}): string =>
  `${n.codColigada}|${n.codProva}|${n.codEtapa}|${TIPOETAPA_NOTA}|${n.idTurmaDisc}|${n.ra}`;
