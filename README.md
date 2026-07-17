# Middleware de Integração TOTVS RM Educacional ↔ Toddle

Middleware assíncrono (Node.js + TypeScript + BullMQ) que mantém o ERP TOTVS RM Educacional e a plataforma Toddle (Open API V2) sincronizados, com separação clara de responsabilidades:

```
FLUXO 1 (cadastros)                          FLUXO 2 (acadêmico) — roadmap
┌─────────────┐    extract    ┌──────────┐   ┌──────────┐   eventos    ┌─────────────┐
│  TOTVS RM   │──────────────>│          │   │  Toddle  │─────────────>│             │
│ API TTALK + │   fan-out em  │Middleware│   │ webhooks/│  transforma  │ Middleware  │
│  banco SQL  │    lotes      │ (BullMQ) │   │ polling  │  + mapeia    │  (BullMQ)   │
└─────────────┘               └────┬─────┘   └──────────┘              └──────┬──────┘
                                   │ upsert por sourceId                      │ SQL direto
                                   v                                         v
                              ┌──────────┐                             ┌─────────────┐
                              │  Toddle  │                             │  Banco RM   │
                              │ Open API │                             │ SFREQUENCIA │
                              └──────────┘                             │ SNOTAS ...  │
                                                                       └─────────────┘
```

- **Fluxo 1 (RM → Toddle)** — pessoas, alunos, professores e responsáveis nascem no RM. O middleware lê a API TTALK, enriquece via banco, transforma no padrão Toddle e faz upsert usando `sourceId` como elo. **Implementado neste repositório: alunos (Students).**
- **Fluxo 2 (Toddle → RM)** — turmas, matrículas, notas, frequência, diário e horários são geridos no Toddle. O middleware captura os eventos, traduz IDs pela tabela de mapeamento e escreve nas tabelas do RM via SQL (a API do RM é majoritariamente leitura). **Roadmap — ver seção no fim.**

## Estrutura de pastas

```
rm-toddle-middleware/
├── docker-compose.yml            # Redis + PostgreSQL locais
├── .env.example                  # todas as variáveis documentadas
├── src/
│   ├── config/
│   │   └── env.ts                # validação Zod fail-fast do ambiente
│   ├── clients/                  # "dialetos" de cada sistema externo
│   │   ├── totvs/
│   │   │   ├── totvsEducationalClient.ts   # API TTALK + paginação hasNext
│   │   │   └── types.ts
│   │   ├── toddle/
│   │   │   ├── toddleClient.ts             # Bearer, IDs String, archive
│   │   │   └── types.ts
│   │   └── rm-database/
│   │       └── rmSqlPool.ts                # SQL Server do RM (mssql)
│   ├── db/
│   │   ├── pool.ts               # PostgreSQL do middleware
│   │   ├── migrate.ts            # runner de migrations
│   │   └── migrations/
│   │       └── 001_id_mapping.sql
│   ├── repositories/
│   │   └── idMappingRepository.ts # upsert idempotente RM <-> Toddle
│   ├── schemas/                  # Zod: payloads de jobs e da API Toddle
│   │   ├── jobs.schema.ts
│   │   └── toddleStudent.schema.ts
│   ├── services/                 # regras de negócio puras
│   │   ├── sourceId.ts           # prefixo + RA
│   │   ├── yearGroupResolver.ts  # série RM -> year group Toddle
│   │   ├── studentEnrichment.ts  # e-mail/dob/gênero via PPESSOA
│   │   └── studentTransformer.ts # RM -> item neutro -> payload Toddle
│   ├── queues/
│   │   ├── connection.ts         # IORedis (maxRetriesPerRequest: null)
│   │   ├── names.ts              # convenção {direção}.{entidade}
│   │   ├── queues.ts             # retry 3x exponencial + factory
│   │   └── deadLetter.ts         # DLQ (listener 'failed')
│   ├── workers/
│   │   └── rm-to-toddle/
│   │       ├── studentSync.processor.ts    # extract + upsert-batch
│   │       └── studentSync.worker.ts       # entrypoint do worker
│   └── scripts/
│       ├── enqueueStudentSync.ts # dispara sync manual
│       ├── scheduleJobs.ts       # cron nativo do BullMQ
│       ├── seedYearGroups.ts     # de-para de year groups
│       └── dlq.ts                # list / reprocess da DLQ
```

## Decisões de arquitetura

**Idempotência em 3 camadas.** (1) tabela `id_mapping` local (chave de negócio `entity_type + rm_code`, com `UNIQUE` também em `toddle_id`); (2) se o RA não está mapeado, `GET /students?sourceIds=...` no Toddle recupera o vínculo (cobre primeira carga, restore do banco local e cadastros manuais); (3) todo sucesso grava o mapeamento imediatamente — a retentativa de um lote parcialmente processado vira `update` em vez de `create` duplicado.

**Extract → fan-out.** Um job `students.extract` varre o RM inteiro e fatia o resultado em lotes de `SYNC_BATCH_SIZE` (padrão 50) com `jobId` determinístico (`{runId}:students:{índice}`). Lotes pequenos falham/retentam isoladamente e paralelizam sem estourar rate limit.

**Resiliência.** `attempts: 3` com backoff exponencial (5s → 10s → 20s). O BullMQ não tem DLQ nativa: um listener de `failed` copia o payload completo (fila de origem, job, dados, motivo, stacktrace) para a fila `dead-letter`, e `npm run dlq` lista/reprocessa manualmente.

**Rate limiting conservador.** Os limites do Toddle **não são documentados**: o worker usa `concurrency: 3` + `limiter 5 req/s`. Ajuste com dados reais de produção.

**`sourceId` imutável.** `SOURCE_ID_PREFIX` + código de negócio do RM (RA). Escolha o formato uma única vez (ex.: `1-` para a coligada 1) e nunca mude — ele é o contrato de identidade entre os sistemas.

**`XxxCode` vs `XxxInternalId`.** O mapeamento usa sempre o **Code** (RA, chapa, código de turma). O `InternalId` é chave técnica do RM: guardamos apenas como referência (`rm_internal_id`) e jamais o montamos manualmente.

## Setup

Pré-requisitos: Node.js 20+, Docker.

```bash
# 1. Infra local (Redis + PostgreSQL)
docker compose up -d

# 2. Dependências
npm install

# 3. Ambiente
cp .env.example .env   # preencha credenciais do RM e token do Toddle

# 4. Migrations (cria a id_mapping)
npm run db:migrate

# 5. De-para de year groups (obrigatório para CRIAR aluno no Toddle)
npm run seed:yeargroups -- list
npm run seed:yeargroups -- map <CourseCodeRM> <yearGroupIdToddle>
# ou defina TODDLE_DEFAULT_YEAR_GROUP_ID no .env como fallback

# 6. Agendamento noturno (opcional, cron em STUDENTS_SYNC_CRON)
npm run schedule

# 7. Worker + disparo manual
npm run worker:students     # terminal 1 — fica escutando a fila
npm run enqueue:students    # terminal 2 — dispara a sincronização
```

Utilitários: `npm run typecheck`, `npm run dlq -- list`, `npm run dlq -- reprocess <id|--all>`.

## Fluxo 1 — passo a passo (alunos)

1. `students.extract` percorre `GET /StudentContexts` com `page`/`pageSize` até `hasNext = false`.
2. Deduplica por `StudentCode` (RA) — o mesmo aluno aparece em vários contextos (curso/turma/período); contexto **ativo** tem prioridade.
3. Filtra por `RM_ACTIVE_TERM_STATUSES` (CSV no `.env`; vazio aceita todos — os domínios de `MajorStatus`/`TermStatus` não são documentados nos specs, levante-os no seu ambiente).
4. Enriquece via SQL no banco do RM (`SALUNO → PPESSOA`): e-mail, nascimento (`YYYY-MM-DD`) e gênero (`M/F`). Passo opcional — sem `RM_SQL_*` no `.env`, é pulado.
5. Fan-out em lotes → `students.upsert-batch`.
6. Cada lote: mapeamento local → busca por `sourceId` no Toddle (desarquivando se preciso) → `PUT` (existe) ou `POST` (novo, com `yearGroupId` resolvido) → upsert na `id_mapping`.
7. O update **não reenvia** `yearGroupId`: mudança de série é decisão pedagógica do Toddle, não do sync.

## Fluxo 2 — roadmap (Toddle → RM via SQL)

As filas já existem (`toddle-to-rm.*`); os workers seguem o mesmo padrão do Fluxo 1 (processor + worker + schemas). Pontos de atenção **antes** de implementar:

- **Escrever direto no banco do RM é arriscado**: as regras de negócio vivem na aplicação, não no schema. Valide cada tabela/coluna/constraint com o dicionário de dados (GDIC) e teste exaustivamente em homologação. Prefira um usuário SQL com permissão mínima (INSERT/UPDATE apenas nas tabelas necessárias).
- Tabelas-alvo típicas: `SFREQUENCIA` (frequência), `SNOTAS` (notas), `SMATRICULA`/`SMATRICPL` (matrículas), `STURMA`/`STURMADISC` (turmas), `SHORARIOTURMA` (horários). Sempre casando `CODCOLIGADA` e preenchendo `RECCREATEDBY`/`RECCREATEDON` para auditoria.
- A tradução Toddle → RM usa a mesma `id_mapping` (agora no sentido inverso: `toddle_id` → `rm_code`/`rm_internal_id`).
- Captura de eventos: webhooks do Toddle (se disponíveis no plano da escola) ou polling agendado com paginação por cursor (`count` + `cursor`) nos endpoints que o usam.

## Limitações conhecidas

- **Toddle 1.0 vs 2.0**: esta implementação segue a Open API V2 do Toddle 1.0. Confirme a versão da sua escola — as docs divergem.
- **Rate limits e emissão de token do Toddle não são documentados** — o token vem do suporte/onboarding; o limiter está conservador de propósito.
- **Domínios de `MajorStatus`/`TermStatus`** do RM não são documentados: levante os valores do seu ambiente e configure `RM_ACTIVE_TERM_STATUSES`.
- **Staff e Parents exigem e-mail** no Toddle (alunos não). Parents exigem `children[]` — carregue alunos antes de responsáveis. Ordem de carga sugerida: estrutura Toddle → subjects → staff → students → parents → courses.
- **IDs do Toddle são sempre String**; do lado RM, nunca construa `InternalId` na mão.
- **Archive ≠ delete**: aluno "removido" continua existindo arquivado; o middleware desarquiva automaticamente se o RM voltar a enviá-lo como ativo.
