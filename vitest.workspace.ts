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
