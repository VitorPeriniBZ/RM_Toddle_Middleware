import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A resposta de NEGAÇÃO não ensina como a porta é fechada.
 *
 * ─── O QUE VAZAVA ───────────────────────────────────────────────────────────
 *
 * O 403 de autorização devolvia, no corpo, o comando de bootstrap pronto para
 * copiar — com o `subject` de quem pediu e `--papel tenant_admin` no fim —, os
 * papéis exigidos pela rota, os papéis que a pessoa tem e o nome da tabela de
 * autorização.
 *
 * Quem recebe um 403 é, por definição, quem autenticou e NÃO tem acesso: toda
 * conta do Workspace da escola, inclusive a de aluno, se houver. A resposta
 * ensinava o modelo de privilégios exatamente a esse público, e entregava o
 * texto para pedir a um administrador sem ele precisar entender o que estava
 * rodando.
 *
 * Os campos também eram um ORÁCULO: "não tem papel nenhum" contra "tem papel,
 * mas não este" diz ao pedinte se ele já é conhecido do sistema, e o nome do
 * papel exigido diz o que protege cada rota. Por isso a mensagem é a MESMA nos
 * dois casos — distinguir já é informação.
 *
 * ─── POR QUE UMA VARREDURA, E NÃO UM TESTE DA FUNÇÃO ────────────────────────
 *
 * Testar só `corpoDeNegacao()` cobriria a função de hoje. O que se quer impedir
 * é o campo "só para ajudar" que alguém acrescenta a QUALQUER resposta de
 * negação daqui a seis meses — foi assim que o primeiro apareceu, com a melhor
 * das intenções e um comentário explicando a utilidade. A varredura olha todas.
 *
 * O log continua com tudo, e é o lugar certo: quem o lê é quem tem acesso ao
 * servidor, que é a única pessoa capaz de executar o comando.
 */

const RAIZ = resolve(__dirname, '../../..');
const FONTE = 'apps/api/src';

/** O que não pode aparecer num corpo de 401/403. */
const PROIBIDO: Array<{ agulha: RegExp; porque: string }> = [
  { agulha: /npm run conceder/, porque: 'o comando de bootstrap é um roteiro de escalonamento' },
  { agulha: /identidade\.subject|payload\.sub\b/, porque: 'devolve a identidade de quem pediu' },
  { agulha: /\bmembership\b/, porque: 'nomeia a tabela que decide autorização' },
  { agulha: /GOOGLE_ALLOWED_HD|GOOGLE_CLIENT_ID/, porque: 'nomeia a variável de configuração do controle' },
  { agulha: /\bexigidos\b|\bseusPapeis\b|\bpapeis\b/, porque: 'diz qual papel protege a rota, ou quais a pessoa tem' },
  { agulha: /tenant_admin|integration_operator|mapping_manager|approver/, porque: 'enumera os papéis do sistema' },
];

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

interface Negacao {
  arquivo: string;
  codigo: string;
  corpo: string;
}

/**
 * Os corpos passados a `reply.code(401|403).send(...)`.
 *
 * O corpo vai do `send(` até o parêntese que o fecha, contando aninhamento —
 * um `.send({ erro: f(x) })` não pode ser cortado no primeiro `)`.
 */
function negacoes(arquivo: string, fonte: string): Negacao[] {
  const out: Negacao[] = [];
  const re = /\.code\((401|403)\)\s*\.send\s*\(/g;
  for (const m of fonte.matchAll(re)) {
    let profundidade = 0;
    const inicio = m.index + m[0].length;
    for (let i = inicio - 1; i < fonte.length; i += 1) {
      if (fonte[i] === '(') profundidade += 1;
      else if (fonte[i] === ')') {
        profundidade -= 1;
        if (profundidade === 0) {
          out.push({ arquivo, codigo: m[1], corpo: fonte.slice(inicio, i) });
          break;
        }
      }
    }
  }
  return out;
}

const arquivos = listarArquivos(resolve(RAIZ, FONTE));
const todas = arquivos.flatMap((a) =>
  negacoes(a.replace(`${RAIZ}/`, ''), readFileSync(a, 'utf8')),
);

describe('a resposta de negação não vaza o modelo de acesso', () => {
  /*
   * Uma varredura que não acha nada passa verde e protege nada. Aconteceu duas
   * vezes neste repositório (a de UPSERT cobria 3 de 17; a de chave de run, 6 de
   * 7), então a contagem é verificada.
   */
  it('a varredura encontra as respostas de 401/403 da API', () => {
    expect(
      todas.length,
      'nenhuma resposta de negação foi encontrada em `apps/api/src`. Ou elas mudaram de forma e ' +
        'o reconhecedor precisa de ajuste, ou a API deixou de negar — e as duas merecem um olhar.',
    ).toBeGreaterThanOrEqual(4);
  });

  it.each(todas.map((n, i) => [`${n.arquivo} → ${n.codigo} (#${i + 1})`, n] as const))(
    '%s',
    (_nome, n) => {
      const achados = PROIBIDO.filter((p) => p.agulha.test(n.corpo)).map((p) => p.porque);
      expect(
        achados,
        `${n.arquivo}: o corpo deste ${n.codigo} ${achados.join('; ')}. Quem recebe uma negação é ` +
          'quem NÃO tem acesso — toda conta do Workspace da escola. Mande o diagnóstico para o ' +
          '`logger.warn` logo acima e devolva só a frase genérica.',
      ).toEqual([]);
    },
  );
});
