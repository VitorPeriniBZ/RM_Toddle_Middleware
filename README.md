# Middleware de Integração TOTVS RM Educacional ↔ Toddle

> **Leia [`docs/DECISOES.md`](docs/DECISOES.md) antes de mudar qualquer coisa.** Ele
> registra as decisões da escola com data e razão, e **algumas contradizem
> documentos mais antigos deste repositório**. Em caso de conflito, o DECISOES.md
> vence.
>
> A mais importante (D1, 06/08/2026): a direção de nota e frequência é
> **Toddle → RM**. Os professores lançam no Toddle e o TOTVS é o destino — o
> inverso do que o diagrama abaixo e vários docs sugerem.
>
> E o fluxo acadêmico escreve por **`wsDataServer`/`SaveRecord`, não por SQL
> direto** como o diagrama diz: o RM tem regra de negócio na aplicação, e
> `PRESENCA='P'` *remove* a ausência em vez de marcar presença. Ver
> [`docs/rm-dataservers/`](docs/rm-dataservers/). Nenhuma escrita acadêmica foi
> feita ainda — o cliente do `wsDataServer` não tem método de escrita, de propósito.

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
- **Fluxo 2 (Toddle → RM)** — notas e frequência lançadas no Toddle voltam para o RM. **Escopo real é menor do que parece:** a API do RM Educacional **não tem POST para aluno, turma nem professor** (só leitura via `/StudentContexts`, `/ProfessorContexts`, `/Professors/{id}/disciplineclasses`); o que ela permite escrever é estrutura acadêmica (`/Academics/{id}/Courses`, `/Majors`, `/CurriculumGrids`, `/appliedmatrixes`, `/terms`, `/Periods`, `/griddisciplines`) e `POST /attendance`. E no CloudTOTVS da EAV esse REST **não está publicado**. Mas o `wsConsultaSQL` NÃO é o único acesso: o **`wsDataServer`** está exposto na mesma porta 1951 e escreve via `SaveRecord`, passando pela camada DataServer do RM (ver seção de decisões). Portanto a volta é viável — o que falta é governança acadêmica, não infraestrutura. **Roadmap — ver seção no fim.**

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

**Extract → fan-out.** Um job `students.extract` varre o RM inteiro e fatia o resultado em lotes de `SYNC_BATCH_SIZE` (padrão 50) com `jobId` determinístico (`{runId}-students-{índice}`). Lotes pequenos falham/retentam isoladamente e paralelizam sem estourar rate limit.

O separador é `-`, **não `:`**, e o `runId` é normalizado: o BullMQ recusa custom jobId com `:` a menos que ele quebre em exatamente 3 partes. O job do scheduler tem id `repeat:<nome>:<millis>`, então o formato antigo derrubava 100% dos disparos por cron — ver o incidente de 07/08 em [`docs/DECISOES.md`](docs/DECISOES.md).

**Resiliência.** `attempts: 3` com backoff exponencial (5s → 10s → 20s). O BullMQ não tem DLQ nativa: um listener de `failed` copia o payload completo (fila de origem, job, dados, motivo, stacktrace) para a fila `dead-letter`, e `npm run dlq` lista/reprocessa manualmente.

**Rate limiting conservador.** Os limites do Toddle **não são documentados**: o worker usa `concurrency: 1` + `limiter 2 req/s` — medido em 31/07, quando `concurrency 3` + `5 req/s` tomou HTTP 429 em massa e mandou 3 lotes para a DLQ. O cliente ainda retenta 429/5xx por conta própria (`ToddleClient.withRetry`, 5 tentativas, honrando `Retry-After` quando ele vem).

Mesmo assim é possível tomar 429: em 07/08, três syncs completos em ~30 min durante testes esgotaram a cota do sandbox. Dois sinais úteis: o Toddle **não** manda `Retry-After`, então o fallback exponencial cobre só ~15s; e syncs em sequência próxima somam contra a mesma janela. Se isso aparecer em produção, o ajuste é alargar o backoff do cliente, não subir o limiter.

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

# 6. Agendamento noturno (cron em STUDENTS_SYNC_CRON, tz America/Sao_Paulo)
npm run schedule            # idempotente — upsert por id do scheduler

# 7. Worker + disparo manual
npm run worker:students     # terminal 1 — fica escutando a fila
npm run enqueue:students    # terminal 2 — dispara a sincronização
```

Utilitários: `npm run typecheck`, `npm run dlq -- list`, `npm run dlq -- reprocess <id|--all>`, `npm run dlq -- remove <id>`.

`dlq -- remove` descarta uma entrada **sem** reprocessar, para o caso "a causa já foi corrigida e reprocessar seria redundante". Ele loga o payload inteiro antes de apagar, e não tem `--all` de propósito: descarte em massa é como se perde uma falha real no meio.

### Worker supervisionado (macOS)

O passo 7 acima é para desenvolvimento. Para o worker sobreviver a crash e a
reboot — **e o cron do passo 6 disparar de fato, porque é o worker que promove o
job atrasado no BullMQ** — use o LaunchAgent:

```bash
mkdir -p logs   # o launchd abre o StandardOutPath ao subir e NÃO cria o diretório
cp scripts/com.escolaamericana.rm-toddle.worker-students.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.escolaamericana.rm-toddle.worker-students.plist

launchctl print gui/$(id -u)/com.escolaamericana.rm-toddle.worker-students  # state, pid, runs
tail -f logs/worker-students.log                                            # log do worker
launchctl kickstart -k gui/$(id -u)/com.escolaamericana.rm-toddle.worker-students  # reiniciar
launchctl bootout gui/$(id -u)/com.escolaamericana.rm-toddle.worker-students       # desligar
```

O plist tem caminhos absolutos (inclusive a versão do Node do nvm) — ajuste se o
repo ou o Node mudarem de lugar. `KeepAlive` recria o processo; `ThrottleInterval
30` evita crashloop marretando o RM; `ExitTimeOut 60` dá tempo ao encerramento
gracioso terminar o lote em andamento (um lote de 50 alunos levou ~27s).

**Não rode o passo 7 com o LaunchAgent ativo.** Seriam dois consumidores na mesma
fila, e o `limiter` é por worker: 2 req/s cada = 4 req/s contra o Toddle, perto do
ponto em que a medição de 31/07 tomou HTTP 429 em massa. Antes de depurar no
terminal, `launchctl bootout` primeiro.

**O log não tem rotação.** `logs/worker-students.log` cresce sem limite — o
`newsyslog` do macOS não olha para ele. Truncar de vez em quando, ou configurar
rotação, antes que vire um arquivo de GB.

**Isto não substitui um host de verdade.** Num laptop que dorme, o job das 3h roda
quando a máquina acorda, não às 3h.

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

- **A EAV usa o Toddle 2.0 (modelo TeacherCourse).** Turmas não seguem o `course` clássico do 1.0: cada oferta é um **TeacherCourse** (turma-disciplina-docente), o que casa bem com o `STURMADISC` do RM. Por isso a `id_mapping` já tem o entity_type `TEACHER_COURSE` (migration 002). As notas de etapa passam pelo **novo Grade Scale** do 2.0 — a escala de notas precisa ser lida/mapeada antes de lançar `SNOTAS`.
- **Os endpoints exatos de TeacherCourse e do novo Grade Scale vêm da coleção do Toddle 2.0** (documentação distinta da V2 "clássica"). Confirme path, campos obrigatórios e shape de resposta na skill `toddle-api` **na versão 2.0** antes de escrever esses workers — não reaproveite às cegas os endpoints de `course`/`term-grades` do 1.0.
- **CORRIGIDO em 2026-08-04: existe caminho de escrita, e ele já está exposto.** Até esta data a conclusão registrada era "o acesso ao RM é read-only; escrever exige publicar o REST ou abrir a porta 1433". **Errado.** O `wsConsultaSQL` é read-only *por natureza* (executa Sentenças `SELECT`), mas o **`wsDataServer`** está publicado no MESMO host e MESMA porta 1951, autentica com as mesmas credenciais e responde: um `ReadRecord` em `EduAlunoData` devolveu o registro completo de um aluno (117 KB, dataset `EduAluno`/`SAluno`). A operação de escrita é `SaveRecord` na mesma interface, e passa pela camada **DataServer**, que aplica as validações do produto — diferente de `INSERT` direto. O `wsProcess` também responde.

  DataServers confirmados por sondagem (`ReadRecord` com chave inválida: `"Classe não encontrada"` = não existe; erro de formato = existe):
  `EduFrequenciaDiariaData`, `EduHorarioTurmaData`, `EduNotasData`, `EduNotaEtapaData`, `EduTurmaDiscData`, `EduMatriculaData`, `EduProfessorData`.
  Não existem: `EduFrequenciaData`, `SFrequenciaData`, `EduFaltaData`, `EduAulaData`, `EduDiarioClasseData`.

  Contexto obrigatório nas chamadas: `CODCOLIGADA;CODFILIAL;CODTIPOCURSO;CODSISTEMA`. Sem ele o RM responde *"Contexto inválido OU não foram configurados os parâmetros do Educacional"*.

  **O bloqueio deixou de ser infraestrutura e passou a ser governança acadêmica.** O RM é o sistema de registro legal da escola. Antes de qualquer escrita: definir o que o Toddle está autorizado a lançar, quem aprova, qual a unidade oficial de frequência, e a política de conflito Toddle × RM. Sonda de escrita sem persistir dado: `docs/rm-sentencas/testar-saverecord.sh`.
- **Escrever direto no banco do RM é arriscado**: as regras de negócio vivem na aplicação, não no schema. Valide cada tabela/coluna/constraint com o dicionário de dados (GDIC) e teste exaustivamente em homologação. Prefira um usuário SQL com permissão mínima (INSERT/UPDATE apenas nas tabelas necessárias).
- Tabelas-alvo típicas: `SFREQUENCIA` (frequência), `SNOTAS` (notas), `SMATRICULA`/`SMATRICPL` (matrículas), `STURMA`/`STURMADISC` (turmas → TeacherCourse), `SHORARIOTURMA` (horários). Sempre casando `CODCOLIGADA` e preenchendo `RECCREATEDBY`/`RECCREATEDON` para auditoria.
- A tradução Toddle → RM usa a mesma `id_mapping` (agora no sentido inverso: `toddle_id` → `rm_code`/`rm_internal_id`).
- Captura de eventos: webhooks do Toddle (se disponíveis no plano da escola) ou polling agendado com paginação por cursor (`count` + `cursor`) nos endpoints que o usam.

## Limitações conhecidas

- **Toddle 2.0 (TeacherCourse) — versão da EAV.** O Fluxo 1 (alunos) usa o núcleo de endpoints estável entre 1.0 e 2.0 (`/public/v2/students`, `/public/v2/year-groups`), então roda igual nas duas versões. As diferenças do 2.0 (modelo **TeacherCourse** e **novo Grade Scale**) afetam o **Fluxo 2** (turmas/notas) e têm documentação própria — leia a skill `toddle-api` 2.0 antes de implementar esses workers.
- **Rate limits e emissão de token do Toddle não são documentados** — o token vem do suporte/onboarding; o limiter está conservador de propósito.
- **Domínios de `MajorStatus`/`TermStatus`** do RM não são documentados: levante os valores do seu ambiente e configure `RM_ACTIVE_TERM_STATUSES`.
- **Staff e Parents exigem e-mail** no Toddle (alunos não). Parents exigem `children[]` — carregue alunos antes de responsáveis. Ordem de carga sugerida: estrutura Toddle → subjects → staff → students → parents → courses.
- **IDs do Toddle são sempre String**; do lado RM, nunca construa `InternalId` na mão.
- **Archive ≠ delete**: aluno "removido" continua existindo arquivado; o middleware desarquiva automaticamente se o RM voltar a enviá-lo como ativo.
