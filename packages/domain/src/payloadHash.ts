import { createHash } from 'node:crypto';

/**
 * A impressão digital do que vamos escrever num sistema de destino.
 *
 * ─── PARA QUE SERVE ─────────────────────────────────────────────────────────
 *
 * Responder, sem rede, à pergunta "o que eu mandaria hoje é igual ao que eu
 * mandei da última vez?". Guardado em `id_mapping.payload_hash`, é o que permite
 * o sync parar de reescrever no Toddle os 252 alunos toda passada quando o RM
 * não mudou nenhum deles.
 *
 * ─── POR QUE NÃO `JSON.stringify` DIRETO ────────────────────────────────────
 *
 * A ordem das chaves de um objeto JS depende de como ele foi MONTADO, não do que
 * ele contém. `{a:1,b:2}` e `{b:2,a:1}` são o mesmo payload e dariam hashes
 * diferentes — e o efeito seria invisível: nenhum erro, só toda a economia
 * evaporando na primeira vez que alguém reordenasse os campos de
 * `toUpdatePayload`. Por isso as chaves são ordenadas em toda profundidade.
 *
 * `undefined` é omitido (é como o JSON já se comporta) e `null` é preservado —
 * "campo ausente" e "campo explicitamente vazio" são coisas diferentes para uma
 * API, e apagar essa diferença esconderia uma escrita de verdade.
 *
 * Array NÃO é ordenado: em payload, ordem de lista é conteúdo.
 */
export function hashDoPayload(valor: unknown): string {
  return createHash('sha256').update(canonico(valor)).digest('hex');
}

function canonico(valor: unknown): string {
  if (valor === null) return 'null';
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`;
  if (typeof valor === 'object') {
    const entradas = Object.entries(valor as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonico(v)}`);
    return `{${entradas.join(',')}}`;
  }
  return JSON.stringify(valor) ?? 'undefined';
}
