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

export const cor = {
  ruim: '#b00020',
  bom: '#0a6b2d',
  atencao: '#8a5a00',
  fundoRuim: '#fdeaec',
  fundoAtencao: '#fff4d6',
  fundoBom: '#eaf6ee',
  borda: '#ddd',
  texto: '#333',
  fraco: '#666',
  fundoFraco: '#f7f7f7',
} as const;

export const s = {
  main: {
    fontFamily: 'system-ui, sans-serif',
    maxWidth: 980,
    margin: '2rem auto',
    padding: '0 1rem',
    color: cor.texto,
  } as CSSProperties,

  h1: { fontSize: '1.4rem', marginBottom: '.2rem' } as CSSProperties,
  h2: { fontSize: '1.1rem', marginTop: '1.6rem' } as CSSProperties,
  h3: { fontSize: '.98rem', margin: 0 } as CSSProperties,

  abas: { display: 'flex', gap: '.4rem', borderBottom: `1px solid ${cor.borda}`, marginTop: '1rem' } as CSSProperties,
  aba: (ativa: boolean): CSSProperties => ({
    padding: '.45rem .9rem',
    border: `1px solid ${ativa ? cor.borda : 'transparent'}`,
    borderBottom: ativa ? '1px solid #fff' : `1px solid ${cor.borda}`,
    marginBottom: -1,
    background: ativa ? '#fff' : 'transparent',
    cursor: 'pointer',
    fontWeight: ativa ? 600 : 400,
    fontSize: '.9rem',
  }),

  cartao: {
    border: `1px solid ${cor.borda}`,
    padding: '.9rem 1rem',
    marginTop: '.8rem',
    background: '#fff',
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

  botao: { padding: '.4rem .8rem', fontSize: '.88rem', cursor: 'pointer' } as CSSProperties,
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
