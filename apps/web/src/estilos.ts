import type { CSSProperties } from 'react';

/**
 * Estilos compartilhados da tela.
 *
 * Objeto de estilo em vez de CSS ou biblioteca: é o que a primeira tela já
 * usava, e trocar a abordagem no mesmo commit que triplica a quantidade de
 * interface misturaria duas mudanças — a de comportamento e a de aparência —
 * numa revisão só.
 *
 * O que importa aqui é semântico, não estético: `ruim`, `bom` e `atencao` são as
 * três cores que dizem se algo precisa de olho, e elas aparecem sempre nos
 * mesmos lugares (divergência, estado de run, DLQ).
 */

/**
 * A paleta proprietária da EAV. **Todo** hex desta tela nasce aqui.
 *
 * As cores semânticas SÃO as da marca, não uma segunda paleta ao lado delas —
 * duas paletas competindo é o caminho mais curto para o vermelho de
 * "divergente" virar enfeite.
 *
 * `atencao` usa o Ocre `#A67206` (a profundidade do amarelo) e não o Amarelo
 * `#FBB216`: amarelo puro sobre branco não alcança contraste AA em texto, e
 * esta tela tem de ser lida, não admirada.
 */
const PALETA = {
  oliva: '#A9A52B', // institucional da marca-mãe
  verde: '#408F38',
  vermelho: '#AB2A25',
  ocre: '#A67206',
  creme: '#F0EEE6',
  branco: '#FFFFFF',
  cinza: '#3D3C3B',
} as const;

/**
 * Mesma cor, com alfa — em hex de 8 dígitos.
 *
 * Existe para que fundo suave e borda sejam DERIVADOS da paleta em vez de
 * hexes novos escolhidos no olho. Um `#F7EAE9` digitado à mão passa na revisão
 * e depois ninguém sabe de onde veio nem como recalculá-lo para outra marca —
 * que é exatamente o que quebra um white label.
 */
const comAlfa = (hex: string, alfa: number): string =>
  hex + Math.round(Math.min(Math.max(alfa, 0), 1) * 255).toString(16).padStart(2, '0').toUpperCase();

export const cor = {
  ruim: PALETA.vermelho,
  bom: PALETA.verde,
  atencao: PALETA.ocre,
  fundoRuim: comAlfa(PALETA.vermelho, 0.08),
  fundoAtencao: comAlfa(PALETA.ocre, 0.1),
  fundoBom: comAlfa(PALETA.verde, 0.08),
  marca: PALETA.oliva,
  borda: comAlfa(PALETA.cinza, 0.18),
  texto: PALETA.cinza,
  fraco: comAlfa(PALETA.cinza, 0.72),
  fundoFraco: PALETA.creme,
} as const;

export const s = {
  // A família vem do `body` (Montserrat, em marca.css) — não repetida aqui, para
  // haver um lugar só que decide tipografia.
  main: {
    maxWidth: 980,
    margin: '0 auto 2rem',
    padding: '0 1rem',
    color: cor.texto,
  } as CSSProperties,

  h1: { fontSize: '1.4rem', marginBottom: '.2rem' } as CSSProperties,
  h2: { fontSize: '1.05rem', marginTop: '1.6rem' } as CSSProperties,
  h3: { fontSize: '.98rem', margin: 0 } as CSSProperties,

  abas: { display: 'flex', gap: '.4rem', borderBottom: `1px solid ${cor.borda}`, marginTop: '1rem' } as CSSProperties,
  aba: (ativa: boolean): CSSProperties => ({
    padding: '.45rem .9rem',
    border: `1px solid ${ativa ? cor.borda : 'transparent'}`,
    borderBottom: ativa ? `1px solid ${PALETA.branco}` : `1px solid ${cor.borda}`,
    marginBottom: -1,
    background: ativa ? PALETA.branco : 'transparent',
    fontFamily: 'inherit',
    cursor: 'pointer',
    fontWeight: ativa ? 600 : 400,
    fontSize: '.9rem',
  }),

  cartao: {
    border: `1px solid ${cor.borda}`,
    padding: '.9rem 1rem',
    marginTop: '.8rem',
    background: PALETA.branco,
  } as CSSProperties,

  linha: { display: 'flex', gap: '.6rem', alignItems: 'center', flexWrap: 'wrap' } as CSSProperties,
  mono: { fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: '.86rem' } as CSSProperties,
  fraco: { color: cor.fraco, fontSize: '.85rem' } as CSSProperties,

  selo: (tipo: 'bom' | 'ruim' | 'atencao' | 'neutro'): CSSProperties => ({
    fontSize: '.72rem',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '.04em',
    padding: '.12rem .4rem',
    border: `1px solid ${tipo === 'bom' ? cor.bom : tipo === 'ruim' ? cor.ruim : tipo === 'atencao' ? cor.atencao : cor.borda}`,
    color: tipo === 'bom' ? cor.bom : tipo === 'ruim' ? cor.ruim : tipo === 'atencao' ? cor.atencao : cor.fraco,
    background: tipo === 'bom' ? cor.fundoBom : tipo === 'ruim' ? cor.fundoRuim : tipo === 'atencao' ? cor.fundoAtencao : cor.fundoFraco,
    whiteSpace: 'nowrap',
  }),

  aviso: (tipo: 'ruim' | 'atencao' | 'bom'): CSSProperties => ({
    background: tipo === 'ruim' ? cor.fundoRuim : tipo === 'atencao' ? cor.fundoAtencao : cor.fundoBom,
    border: `1px solid ${tipo === 'ruim' ? cor.ruim : tipo === 'atencao' ? cor.atencao : cor.bom}`,
    padding: '.55rem .7rem',
    fontSize: '.88rem',
    marginTop: '.5rem',
  }),

  botao: {
    padding: '.4rem .8rem',
    fontSize: '.88rem',
    cursor: 'pointer',
    fontFamily: 'inherit',
    background: PALETA.branco,
    color: cor.texto,
    border: `1px solid ${cor.borda}`,
  } as CSSProperties,

  /**
   * Barra de resumo no topo de uma aba: a resposta antes da leitura.
   *
   * Sem ela a tela obriga a ler quatro cartões para descobrir que está tudo bem —
   * e quem lê quatro cartões todo dia para ver "ok" para de ler.
   */
  barra: {
    display: 'flex',
    gap: '1.4rem',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    padding: '.6rem .8rem',
    border: `1px solid ${cor.borda}`,
    background: PALETA.branco,
    marginTop: '1rem',
  } as CSSProperties,

  /** Um número grande com rótulo pequeno embaixo. */
  kpiNumero: (tipo: 'bom' | 'ruim' | 'atencao' | 'neutro' = 'neutro'): CSSProperties => ({
    fontSize: '1.25rem',
    fontWeight: 700,
    lineHeight: 1.1,
    color: tipo === 'bom' ? cor.bom : tipo === 'ruim' ? cor.ruim : tipo === 'atencao' ? cor.atencao : cor.texto,
  }),
  kpiRotulo: { fontSize: '.72rem', color: cor.fraco, textTransform: 'uppercase', letterSpacing: '.04em' } as CSSProperties,

  /**
   * Desejado × observado lado a lado.
   *
   * Eram duas linhas de tabela com o mesmo peso de "próximos disparos". A
   * comparação é o coração da aba — se o Redis perdeu o scheduler, NADA dá erro
   * e o worker segue consumindo uma fila que não recebe mais nada. Lado a lado,
   * a divergência se vê antes de ler.
   */
  comparacao: {
    display: 'grid',
    gridTemplateColumns: '1fr auto 1fr',
    gap: '.5rem .8rem',
    alignItems: 'center',
    marginTop: '.7rem',
    padding: '.6rem .7rem',
    background: cor.fundoFraco,
    border: `1px solid ${cor.borda}`,
  } as CSSProperties,

  /** Rótulo miúdo acima de um valor. */
  dadoRotulo: { fontSize: '.7rem', color: cor.fraco, textTransform: 'uppercase', letterSpacing: '.04em' } as CSSProperties,

  /** Tira de metadados: rótulo e valor em pares, embrulhando. */
  tira: {
    display: 'flex',
    gap: '.3rem 1.3rem',
    flexWrap: 'wrap',
    marginTop: '.6rem',
    fontSize: '.85rem',
  } as CSSProperties,

  /** `<summary>` de um bloco recolhido: some do caminho até ser preciso. */
  resumoDetalhe: {
    cursor: 'pointer',
    fontSize: '.8rem',
    color: cor.fraco,
    marginTop: '.6rem',
    userSelect: 'none',
  } as CSSProperties,

  /** Bloco de texto técnico dentro de um detalhe recolhido. */
  blocoTecnico: {
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
    fontSize: '.78rem',
    background: cor.fundoFraco,
    border: `1px solid ${cor.borda}`,
    padding: '.5rem .6rem',
    marginTop: '.4rem',
    overflowX: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  } as CSSProperties,
  campo: { padding: '.4rem', fontSize: '.88rem', fontFamily: 'ui-monospace, Menlo, monospace' } as CSSProperties,
  tabela: { borderCollapse: 'collapse', width: '100%', fontSize: '.86rem' } as CSSProperties,
  td: { borderTop: `1px solid ${cor.borda}`, padding: '.35rem .5rem', verticalAlign: 'top' } as CSSProperties,
  th: { textAlign: 'left', padding: '.35rem .5rem', fontSize: '.76rem', color: cor.fraco, textTransform: 'uppercase' } as CSSProperties,
};

/** Data e hora curtas, no fuso de quem olha, com o dia quando não é hoje. */
export function quando(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const hoje = new Date().toDateString() === d.toDateString();
  return hoje
    ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** "há 3h" / "há 2 dias" — a forma como a pergunta é feita de verdade. */
export function desde(iso: string | null | undefined): string {
  if (!iso) return 'nunca';
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `há ${h}h`;
  return `há ${Math.floor(h / 24)} dias`;
}
