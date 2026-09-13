import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Todo `ON CONFLICT ... DO UPDATE` atualiza TODAS as colunas que insere.
 *
 * ─── O DEFEITO QUE ISTO PEGA ────────────────────────────────────────────────
 *
 * `abrirRun` inseria `tipo` e não o atualizava no conflito. Consequência: o
 * valor gravado na PRIMEIRA vez que a chave apareceu ficava para sempre, e
 * nenhuma correção de código o alcançava enquanto aquela chave durasse.
 *
 * Custou meio dia em 12/09/2026, em três camadas: o job não gravava run; passou
 * a gravar com o tipo errado; passou a gravar com o tipo certo e a linha velha o
 * sobrescrevia. A chave do run inclui a data, então o engano duraria até a
 * virada do dia — tempo de sobra para alguém concluir que o conserto falhou.
 *
 * ─── POR QUE UMA GUARDA MECÂNICA, E NÃO UM TESTE POR CASO ───────────────────
 *
 * Este é o formato puro de "estado que impede o próprio conserto": a linha
 * errada é a razão pela qual a linha não é corrigida. Um teste por UPSERT nunca
 * cobriria os que ainda serão escritos; esta varredura cobre.
 *
 * ─── A VARREDURA TEM DE COBRIR TUDO, E ISSO É VERIFICADO ────────────────────
 *
 * A primeira versão desta guarda casava 3 de 17 `ON CONFLICT` do repositório e
 * passava verde — uma guarda que quase não guardava, que é o mesmo tipo de
 * silêncio que ela existe para caçar. Por isso o primeiro teste conta os
 * `ON CONFLICT` do repositório e exige que a varredura tenha achado TODOS.
 *
 * ─── COMO DECLARAR A EXCEÇÃO, QUANDO FOR DE PROPÓSITO ───────────────────────
 *
 * Existe caso legítimo de não atualizar: coluna que registra a PRIMEIRA vez, ou
 * cujo valor é igual por construção. Declare no corpo do SET:
 *
 *     -- upsert-preserva: <por quê>
 *
 * Exigir a justificativa escrita é o ponto: a exceção fica onde alguém a lê, em
 * vez de ser a ausência silenciosa de uma linha.
 */

const RAIZ = resolve(__dirname, '../../..');
const PASTAS = ['packages/db/src', 'apps/worker/src', 'apps/api/src'];

/** Colunas que ninguém atualiza num conflito, e que não pedem justificativa. */
const SEMPRE_PRESERVADAS = new Set(['id', 'tenant_id', 'created_at', 'criado_em']);

interface Upsert {
  arquivo: string;
  tabela: string;
  inseridas: string[];
  atualizadas: string[];
  /** Colunas do `ON CONFLICT (...)`: iguais por construção. */
  chaveDoConflito: string[];
  justificativas: number;
  /** `DO NOTHING` não atualiza nada, e isso é uma decisão, não uma omissão. */
  doNothing: boolean;
}

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

/**
 * As strings de template do arquivo — é onde o SQL deste projeto vive.
 *
 * Separar isto ANTES de procurar SQL é o que torna a varredura confiável: cada
 * query fica num pedaço próprio, e o `ON CONFLICT` de uma não pode ser casado
 * com o `INSERT` da seguinte.
 */
function stringsDeSql(fonte: string): string[] {
  return [...fonte.matchAll(/`([^`]*)`/g)]
    .map((m) => m[1])
    .filter((s) => /INSERT\s+INTO/i.test(s) && /ON\s+CONFLICT/i.test(s));
}

function analisar(arquivo: string, sql: string): Upsert | null {
  const ins = /INSERT\s+INTO\s+(\w+)\s*\(([^)]*)\)/i.exec(sql);
  if (!ins) return null;

  // O alvo do conflito pode conter chamada de função com parênteses aninhados
  // — `ON CONFLICT (tenant_id, entidade, coalesce(campo, ''))`. Por isso o alvo
  // é tudo que existe entre `ON CONFLICT` e `DO UPDATE|DO NOTHING`, em vez de um
  // par de parênteses casado por regex.
  const conflito = /ON\s+CONFLICT([\s\S]*?)DO\s+(NOTHING|UPDATE)/i.exec(sql);
  if (!conflito) return null;

  const inseridas = ins[2]
    .split(',')
    .map((c) => c.trim())
    .filter((c) => /^\w+$/.test(c));

  const chaveDoConflito = (conflito[1] ?? '')
    .replace(/[()']/g, ' ')
    .split(/[\s,]+/)
    .map((c) => c.trim())
    .filter((c) => /^\w+$/.test(c) && c.toLowerCase() !== 'coalesce');

  const doNothing = conflito[2].toUpperCase() === 'NOTHING';

  const depoisDoSet = sql.slice(conflito.index + conflito[0].length);
  const corpoSet = depoisDoSet.split(/\bRETURNING\b/i)[0];
  const semComentario = corpoSet.replace(/--[^\n]*/g, '');
  const atualizadas = [...semComentario.matchAll(/(?:^|,|SET)\s*(\w+)\s*=/gim)].map((x) => x[1]);
  const justificativas = [...corpoSet.matchAll(/--\s*upsert-preserva:/gi)].length;

  return {
    arquivo: arquivo.replace(`${RAIZ}/`, ''),
    tabela: ins[1],
    inseridas,
    atualizadas,
    chaveDoConflito,
    justificativas,
    doNothing,
  };
}

const arquivos = PASTAS.flatMap((p) => listarArquivos(resolve(RAIZ, p)));

const upserts: Upsert[] = arquivos.flatMap((a) =>
  stringsDeSql(readFileSync(a, 'utf8'))
    .map((sql) => analisar(a, sql))
    .filter((u): u is Upsert => u !== null),
);

/**
 * Quantos `ON CONFLICT` existem em SQL de verdade.
 *
 * Conta só dentro das strings de template, e não no arquivo inteiro: vários
 * comentários deste projeto EXPLICAM o `ON CONFLICT DO NOTHING` que usam, e
 * contá-los inflaria o denominador — a guarda acusaria uma lacuna que não
 * existe, e alguém acabaria relaxando a contagem para calar o teste.
 */
const totalNoRepo = arquivos.reduce(
  (n, a) =>
    n +
    stringsDeSql(readFileSync(a, 'utf8')).reduce(
      (m, sql) => m + (sql.match(/ON\s+CONFLICT/gi) ?? []).length,
      0,
    ),
  0,
);

describe('todo UPSERT atualiza o que insere', () => {
  // Uma varredura que acha metade passa verde e protege metade. Aconteceu: a
  // primeira versão casava 3 de 17. Se este teste falhar, conserte o
  // reconhecedor — não relaxe a contagem.
  it('a varredura cobre TODOS os ON CONFLICT do repositório', () => {
    expect(
      upserts.length,
      `a varredura achou ${upserts.length} de ${totalNoRepo} ON CONFLICT. Os que faltam não ` +
        'estão sendo verificados, e uma guarda que cobre parte é pior que nenhuma — dá a ' +
        'impressão de proteção. Ajuste `stringsDeSql`/`analisar`.',
    ).toBe(totalNoRepo);
  });

  it.each(upserts.map((u, i) => [`${u.arquivo} → ${u.tabela} (#${i + 1})`, u] as const))(
    '%s',
    (_nome, u) => {
      // `DO NOTHING` é uma decisão explícita de não tocar na linha existente.
      if (u.doNothing) return;

      const presas = u.inseridas.filter(
        (c) =>
          !SEMPRE_PRESERVADAS.has(c) &&
          !u.chaveDoConflito.includes(c) &&
          !u.atualizadas.includes(c),
      );

      expect(
        presas.length === 0 || u.justificativas >= presas.length,
        `${u.arquivo} (${u.tabela}): o INSERT grava [${presas.join(', ')}] e o ON CONFLICT DO ` +
          'UPDATE não atualiza essas colunas. Um valor errado gravado antes fica PRESO, e ' +
          'nenhuma correção de código o alcança enquanto a chave durar — foi assim que a tela ' +
          'ficou dizendo "último sucesso: nunca" depois de DOIS consertos. Se a coluna deve ' +
          'mesmo ficar como está, declare no corpo do SET: `-- upsert-preserva: <por quê>`',
      ).toBe(true);
    },
  );
});
