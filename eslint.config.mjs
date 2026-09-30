import parser from '@typescript-eslint/parser';

/**
 * ESLINT MÍNIMO — O DETECTOR DA CLASSE QUE CAUSOU DANO.
 *
 * ─── ESTE ARQUIVO NÃO É "O LINT DO PROJETO" ────────────────────────────────
 *
 * Ele existe para DUAS regras, e nada mais. O ESLint pleno — com
 * `typescript-eslint` estrito, baseline de 35 mil linhas e política de
 * warning × error — é item próprio, ainda não feito.
 *
 * Misturar as duas coisas custaria caro no lugar errado: um lint que chega
 * junto com centenas de achados de estilo é um lint que alguém desliga, e
 * junto com ele iriam as duas regras que protegem o registro acadêmico.
 *
 * ─── POR QUE AS REGRAS, E NÃO A FLAG DO COMPILADOR ─────────────────────────
 *
 * `noUncheckedIndexedAccess` foi medida: 253 erros no repositório. E ela **não
 * teria pego nenhum dos dois defeitos reais** que motivaram este arquivo:
 *
 *   String(row.CODETAPA)              compila — `String` aceita `undefined`
 *   `${row.IDTURMADISC}|${...}`       compila — template literal também
 *
 * A flag é higiene de tipos e defesa em profundidade FORA da classe que causou
 * dano. Estas duas regras são o detector DA classe. Quando o orçamento é para
 * uma coisa só, é o detector. A flag está registrada em `docs/PLANO.md` como
 * decisão de orçamento, com os números.
 *
 * ─── POR QUE AS REGRAS OLHAM O NOME DA VARIÁVEL ────────────────────────────
 *
 * `no-restricted-syntax` é sintático: não sabe que `row` é
 * `Record<string, string>`. Uma regra que proibisse `String(qualquerCoisa.x)`
 * pescaria dezenas de usos legítimos e seria desligada na primeira semana.
 *
 * A regra mira a CONVENÇÃO de nome (ver `LINHA_DO_RM` abaixo) e o ESCOPO de
 * arquivo. As duas restrições existem para o sinal não afogar: medido, a
 * versão ampla dava 83 achados e a estreita dá 5.
 */

/**
 * O que uma linha de result set do RM se chama neste repositório.
 *
 * ─── POR QUE SÓ `row`, E NÃO TAMBÉM `r` ────────────────────────────────────
 *
 * A primeira versão desta regra aceitava `/^(row|r)$/` e produziu 83 achados,
 * quase todos falsos: `r` é o nome curto genérico do repositório inteiro —
 * entrada da DLQ no vigia (`dlq.recentes.map((r) => ...)`), registro do
 * TODDLE em `toddleGradeSource` (que nem é linha do RM), item de relatório nos
 * scripts. Uma regra assim seria desligada na primeira semana, e junto com ela
 * iriam as duas travas que protegem o registro acadêmico.
 *
 * `row` é a convenção consistente para linha de result set do RM nos leitores.
 * Limitação declarada: quem chamar de `linha` escapa. A regra garante que o
 * padrão CONHECIDO não volta — não substitui leitura.
 */
const LINHA_DO_RM = '/^row$/';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '**/dist/**',
      'apps/web/**', // tem tsconfig próprio e não lê result set do RM
      'backups/**',
      'logs/**',
    ],
  },
  {
    /*
     * ESCOPO: só onde result set do RM é lido.
     *
     * Aplicar em todo o repositório multiplicaria o ruído sem acrescentar
     * proteção: `String(x.y)` num script de relatório não escreve no registro
     * acadêmico. Aqui é onde a linha crua do `Record<string, string>` entra.
     */
    files: [
      'packages/domain/src/rm*.ts',
      'packages/integrations/src/rm-soap/**/*.ts',
      'packages/integrations/src/rm-database/**/*.ts',
    ],
    languageOptions: {
      parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // (i) O defeito de `sincronizarAvaliacoes`, achado no P1-B.
          selector: `CallExpression[callee.name="String"] > MemberExpression[object.name=${LINHA_DO_RM}]`,
          message:
            'String() sobre campo de linha do RM: se a coluna sumir do result set, isto produz ' +
            'a STRING "undefined" — não um vazio. "1|undefined|1|N|1714|RA" tem cara de chave ' +
            'válida em log e passa por qualquer guarda de "está vazio?". Use `pick()` com ' +
            'descarte da linha, ou `chaveComposta`, que recusa o componente.',
        },
        {
          // (ii) O defeito das duas chaves inline, achado no P1-C.
          selector: `TemplateLiteral > MemberExpression[object.name=${LINHA_DO_RM}]`,
          message:
            'Campo de linha do RM interpolado cru em template literal: coluna ausente vira a ' +
            'palavra "undefined" na chave. O que acontece depois depende de como quem consulta ' +
            'reage ao miss — no pior caso (`get(chave) ?? []`) o sistema conclui "não existe" e ' +
            'CRIA registro duplicado no RM. Use `chaveComposta`, que recusa na origem.',
        },
      ],
    },
  },
];
