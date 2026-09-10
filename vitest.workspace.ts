import { defineWorkspace } from 'vitest/config';

/**
 * Duas suítes, e a separação é o ponto.
 *
 * ─── `unit`: pura, roda em qualquer lugar ───────────────────────────────────
 *
 * Sem Postgres, sem Redis, sem RM, sem Toddle. É a suíte que o CI roda em todo
 * push, e por isso tem de terminar em segundos e nunca falhar por rede.
 *
 * O que mora aqui é a lógica que decide se a integração escreve no registro
 * acadêmico de um aluno — `decidirEscrita` e `avaliarVolume`. Foram escritas
 * puras de propósito, justamente para caberem numa suíte assim: é o tipo de
 * regra cujo erro não aparece como exceção, e sim como ausência apagada no
 * diário de um aluno, semanas depois, sem log.
 *
 * ─── `integration`: exige Postgres de verdade ───────────────────────────────
 *
 * `docker compose up -d` + `npm run db:migrate` antes.
 *
 * Não é preguiça de mockar: o que estes testes verificam **é** comportamento do
 * Postgres. O índice único com `coalesce(campo, '')` (porque NULL não participa
 * de UNIQUE), a aritmética jsonb dentro do `UPDATE` lendo o valor anterior da
 * própria linha, os `CHECK` que recusam estado inválido, o `ON DELETE RESTRICT`
 * que impede aprovação órfã. Mockar isso testaria o mock.
 *
 * NÃO existe suíte para o cliente SOAP. Ele fica como script de integração
 * contra o RM de desenvolvimento — mockar SOAP não documentado é codificar a
 * suposição errada e chamá-la de teste.
 */
export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['packages/*/src/**/*.test.ts'],
      environment: 'node',
      // ─── AMBIENTE MÍNIMO, E ISTO CONSERTA O CI ────────────────────────────
      //
      // `packages/config/src/env.ts` valida com Zod na importação e chama
      // `process.exit(1)` se faltar variável obrigatória — fail-fast, e é o
      // comportamento certo para um processo que fala com o ERP de uma escola.
      //
      // O efeito colateral: qualquer teste que importe `@rm-toddle/config`
      // (mesmo só para o `logger`) executa essa validação. Localmente o `.env`
      // da máquina supre e ninguém percebe. No CI não existe `.env` — ele é
      // gitignored — e TRÊS arquivos da suíte pura morriam na coleta, sem rodar
      // um único teste: assessmentProjection, gradeProjection e
      // toddleGradeSource. A suíte reportava "4 passed" de 7 arquivos.
      //
      // Estes valores são PLACEHOLDER de propósito. A suíte pura não fala com
      // Postgres, Redis, RM nem Toddle; se algum teste passar a falar, o token
      // falso e a DATABASE_URL apontando para lugar nenhum fazem isso falhar
      // ALTO, em vez de silenciosamente usar a credencial real da máquina de
      // quem rodou. `dotenv` não sobrescreve o que já está no ambiente, então o
      // `.env` local também não vaza para cá.
      env: {
        TENANT_SLUG: 'unit-teste',
        RM_CODFILIAL: 'ALL',
        TODDLE_TOKEN: 'token-de-teste-nao-usar',
        TODDLE_ORG_ID: 'org-de-teste',
        DATABASE_URL: 'postgres://nao/existe',
        API_AUTH_MODE: 'localhost',
      },
    },
  },
  {
    test: {
      name: 'integration',
      include: ['packages/*/src/**/*.itest.ts', 'apps/*/src/**/*.itest.ts'],
      environment: 'node',
      // TENANT PRÓPRIO, e isto não é detalhe de arrumação.
      //
      // Em 24/08/2026 a suíte apagou as 24 linhas de proveniência da primeira
      // escrita real no RM, porque um `limpar` fazia `delete from
      // rm_write_provenance` sem cláusula. Rodar sob o tenant de uma escola de
      // verdade é destrutivo por construção; sob um tenant só da suíte, não há o
      // que destruir. `dotenv` não sobrescreve o ambiente, então o `.env` da
      // máquina não vaza para cá.
      env: { TENANT_SLUG: 'integracao-teste' },
      globalSetup: ['./vitest.integracao.setup.ts'],
      // Um banco, uma conexão: testes que mexem nas mesmas tabelas em paralelo
      // produzem falha intermitente, que é pior que teste lento.
      fileParallelism: false,
      testTimeout: 30_000,
    },
  },
]);
