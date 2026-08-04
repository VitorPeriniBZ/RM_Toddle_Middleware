# Arquitetura — monorepo

```
apps/
  worker/   plano de EXECUÇÃO — consome filas e executa operações
  api/      plano de CONTROLE — autentica, autoriza, cria operações duráveis
  web/      interface — nunca fala com RM, Toddle, Redis ou Postgres
packages/
  config/        configuração validada (Zod), logger, utilitários puros
  contracts/     schemas Zod compartilhados
  db/            PostgreSQL do middleware: migrations e repositórios
  integrations/  adaptadores TOTVS RM e Toddle
  domain/        regras de negócio puras
  queues/        BullMQ — compartilhado porque a API também enfileira
```

## Por que monorepo, e por que estas fronteiras

O ganho **não** é reaproveitar schemas Zod. É impedir que a regra de *"o que pode
ser aprovado e escrito"* exista em três versões — uma na UI, uma na API e uma no
worker. Ela vive em `packages/domain` e ninguém mais decide.

O fluxo obrigatório é:

```
web → api → cria operação durável → worker executa → audita
```

A UI nunca chama RM, Toddle, Redis ou Postgres. Se ela pudesse, a validação
viraria decoração: bastaria um `curl` para contornar.

## Grafo de dependências

Acíclico, e é o que justificou o corte dos pacotes:

```
config, contracts          (folhas)
db            -> config
integrations  -> config, contracts
domain        -> config, contracts, db, integrations
queues        -> config
apps/*        -> tudo
```

Import cruzado passa **sempre** pelo nome do pacote (`@rm-toddle/domain`), nunca
por caminho relativo — a fronteira fica visível no código. Cada pacote expõe um
`src/index.ts` como superfície pública; o que não está lá é interno.

## O que ainda NÃO existe

`apps/api` e `apps/web` são esqueletos. A ordem de construção, recomendada pelo
conselho técnico e registrada aqui para não se perder:

1. **Workbench de mapeamento** — login com papéis, lista de pendências
   acionáveis (109 códigos de curso acadêmico, 37 disciplinas → subjects, 5
   e-mails de professor), edição de de-para com validação e justificativa,
   prévia de impacto antes de salvar, dry-run por escopo explícito, histórico.
   Escreve **só no nosso banco**, nunca no RM.
2. **Escrita no RM** como produto separado dentro do mesmo sistema: uma máquina
   de operações aprováveis, não "mais um botão na tela".

Não entram na v1: escrita no RM, aprovação de frequência/notas, SQL livre, ações
destrutivas de fila, configurador white-label completo.

## Autenticação (quando a API existir)

Google OIDC, com dois detalhes que são fáceis de errar:

- a identidade estável é a claim **`sub`**, não o e-mail — e-mail muda;
- pertencer ao Workspace (claim **`hd`**) é autenticação, **não** autorização.
  Quem pode o quê vive em `membership`, com os papéis `viewer`,
  `mapping_manager`, `integration_operator`, `approver` e `tenant_admin`.

Para aprovar escrita no RM: reautenticação recente, quem propõe não aprova, dois
aprovadores em lote ou correção retroativa, e a aprovação vincula um payload
**imutável** — qualquer edição invalida.

## Multi-tenant

`tenant_id` está na chave única de `id_mapping` desde a migration 006, e o
repositório **aborta** se `TENANT_SLUG` não resolver, em vez de degradar para
"sem filtro" — degradar exporia mapeamento de outra escola. Testado criando um
segundo tenant: ele vê zero registros do primeiro.

Credenciais entram como `secret_ref` a cofre/KMS, nunca material secreto no
banco.
