import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A chave do RUN nunca é a mesma da APROVAÇÃO.
 *
 * ─── O DEFEITO QUE ISTO PEGA ────────────────────────────────────────────────
 *
 * São duas perguntas diferentes carregadas pela mesma string:
 *
 *   APROVAÇÃO identifica a INTENÇÃO — "escrever esta janela, neste escopo".
 *   Precisa ser ESTÁVEL: reexecutar tem de reencontrar a decisão já tomada, em
 *   vez de empilhar um pedido novo a cada rodada.
 *
 *   RUN identifica a EXECUÇÃO. Precisa ser ÚNICA por disparo, porque `abrirRun`
 *   faz UPSERT pela chave.
 *
 * Estabilidade e unicidade se excluem. Com uma chave só, toda passada do dia
 * sobrescreve a MESMA linha de `job_run`, e o que sobra é uma linha por dia com
 * início da primeira passada, desfecho da última e "duração" igual ao vão entre
 * as duas. Em 14/09/2026 o gráfico de Notas dizia "maior terminado: 235 min"
 * enquanto a lista logo acima mostrava runs de 20 a 29 segundos (PR #30). O
 * mesmo defeito estava, intacto, em `escreverFrequencia`.
 *
 * ─── POR QUE MECÂNICA, E NÃO UM TESTE POR FLUXO ─────────────────────────────
 *
 * Consertei o de Notas, o de Avaliações e o de Frequência um a um; nenhum dos
 * três consertos alcançava o quarto fluxo, que ainda não existe. Esta varredura
 * alcança.
 *
 * ─── O QUE ELA NÃO VERIFICA ─────────────────────────────────────────────────
 *
 * Que a chave do run seja MESMO única por execução — isso depende do valor em
 * tempo de execução, não do texto. O que dá para afirmar lendo o programa é que
 * ela não é a mesma variável da aprovação, e é esse exato engano que já custou
 * dois fluxos. Onde a chave do run é o `job.id` ou o `runId` (únicos por
 * construção), não há aprovação no arquivo e nada a comparar.
 */

const RAIZ = resolve(__dirname, '../../..');
const PASTAS = ['apps/worker/src', 'apps/api/src'];

function listarArquivos(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listarArquivos(p));
    else if (e.name.endsWith('.ts') && !e.name.includes('.test.') && !e.name.includes('.itest.')) {
      out.push(p);
    }
  }
  return out;
}

/** O trecho entre `nome(` e o parêntese que o fecha, contando aninhamento. */
function argumentosDe(fonte: string, nome: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b${nome}\\s*\\(`, 'g');
  for (const m of fonte.matchAll(re)) {
    let profundidade = 0;
    const inicio = m.index + m[0].length;
    for (let i = inicio - 1; i < fonte.length; i += 1) {
      const c = fonte[i];
      if (c === '(') profundidade += 1;
      else if (c === ')') {
        profundidade -= 1;
        if (profundidade === 0) {
          out.push(fonte.slice(inicio, i));
          break;
        }
      }
    }
  }
  return out;
}

/**
 * O identificador passado em `chave`, seja `chave: x` ou a forma abreviada
 * `chave` — que é como `staffSync` escreve, e que a primeira versão desta
 * varredura não enxergava (6 de 7; a contagem acusou).
 */
function chaveDoObjeto(args: string): string | null {
  const explicita = /\bchave\s*:\s*([A-Za-z_$][\w$]*)\s*[,\n}]/.exec(args);
  if (explicita) return explicita[1];
  const abreviada = /(?:^|[{,])\s*chave\s*(?=[,\n}])/.test(args);
  return abreviada ? 'chave' : null;
}

interface Arquivo {
  caminho: string;
  chavesDeRun: string[];
  chavesDeAprovacao: string[];
}

const arquivos: Arquivo[] = PASTAS.flatMap((p) => listarArquivos(resolve(RAIZ, p)))
  .map((caminho) => {
    const fonte = readFileSync(caminho, 'utf8');
    const chavesDeRun = argumentosDe(fonte, 'abrirRun')
      .map(chaveDoObjeto)
      .filter((c): c is string => c !== null);

    // `pedirAprovacao({ chave })` e `estaAprovado(chave)` — objeto e posicional.
    const dePedido = argumentosDe(fonte, 'pedirAprovacao')
      .map(chaveDoObjeto)
      .filter((c): c is string => c !== null);
    const deConsulta = argumentosDe(fonte, 'estaAprovado')
      .map((a) => /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(a)?.[1] ?? null)
      .filter((c): c is string => c !== null);

    return { caminho: caminho.replace(`${RAIZ}/`, ''), chavesDeRun, chavesDeAprovacao: [...dePedido, ...deConsulta] };
  })
  .filter((a) => a.chavesDeRun.length > 0);

/**
 * Quantos `abrirRun(` existem de verdade.
 *
 * A primeira versão da varredura de UPSERT deste repositório casava 3 de 17 e
 * passava verde — uma guarda que quase não guardava é o mesmo silêncio que ela
 * existe para caçar. Por isso a contagem é conferida.
 */
const chamadasNoRepo = PASTAS.flatMap((p) => listarArquivos(resolve(RAIZ, p))).reduce(
  (n, a) => n + (readFileSync(a, 'utf8').match(/\babrirRun\s*\(/g) ?? []).length,
  0,
);

const reconhecidas = arquivos.reduce((n, a) => n + a.chavesDeRun.length, 0);

describe('a chave do RUN não é a chave da APROVAÇÃO', () => {
  it('a varredura reconhece TODAS as chamadas de abrirRun', () => {
    expect(
      reconhecidas,
      `a varredura entendeu a chave de ${reconhecidas} de ${chamadasNoRepo} chamadas de ` +
        '`abrirRun`. As que faltam não estão sendo verificadas, e uma guarda que cobre parte é ' +
        'pior que nenhuma. Se alguma chamada passa uma EXPRESSÃO em vez de uma variável, ' +
        'extraia-a para uma variável nomeada — aqui isso também deixa o código mais claro.',
    ).toBe(chamadasNoRepo);
  });

  it.each(arquivos.map((a) => [a.caminho, a] as const))('%s', (_nome, a) => {
    const colididas = a.chavesDeRun.filter((c) => a.chavesDeAprovacao.includes(c));
    expect(
      colididas,
      `${a.caminho}: [${colididas.join(', ')}] serve de chave para o RUN e para a APROVAÇÃO ao ` +
        'mesmo tempo. São requisitos opostos — a da aprovação tem de ser ESTÁVEL entre passadas ' +
        '(senão o gate pede decisão de novo a cada rodada) e a do run tem de ser ÚNICA por ' +
        'passada (senão `abrirRun` faz UPSERT na mesma linha e as execuções do dia viram uma ' +
        'linha só, com "duração" igual ao vão entre a primeira e a última). Separe em duas: ' +
        '`const chaveRun = `${chaveDeAprovacao}:${hora}`;`',
    ).toEqual([]);
  });
});
