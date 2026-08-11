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

**Dois agendamentos, escalonados.** `STUDENTS_SYNC_CRON` define o de alunos; o de professores é derivado dele **somando 30 minutos** (`0 3` → `30 3`). Não é estética: a janela de rate limit do Toddle é de 300s e os dois falam com a mesma organização, então sobrepor é a receita para os dois falharem. Se `STUDENTS_SYNC_CRON` não for `m h * * *`, o de professores cai no default `30 3 * * *` — melhor um horário previsível que um cron calculado errado em silêncio.

Um `Worker` do BullMQ é por fila, então há dois — **no mesmo processo e container**: `rm-to-toddle.students` (com fan-out em lotes) e `rm-to-toddle.staff` (sem fan-out; são 35 professores e ~200 turma-disciplina, fatiar traria só complexidade). O encerramento gracioso fecha os dois.

**O agendamento se auto-cura.** O registro do scheduler vive **só no Redis**. Se o Redis reiniciar sem persistência, o `students-sync-nightly` desaparece e **nada dá erro** — o worker fica de pé, saudável, consumindo uma fila que nunca mais recebe nada; você descobre dias depois, ao notar que o Toddle parou de atualizar.

Por isso o worker re-registra o agendamento no boot **e em cada reconexão ao Redis** (`manterAgendamentoDeAlunos`, em `packages/queues/src/schedulers.ts`). O evento de reconexão é o que importa: quando o Redis reinicia, o worker não reinicia — ele reconecta, então registrar só no boot não cobriria justamente esse caso. A definição do agendamento é única e compartilhada com `npm run schedule`, para o cron não divergir entre os dois lugares e criar dois schedulers.

Verificado em 07/08/2026: com o worker de pé, apagadas todas as chaves `repeat*` e o job atrasado, uma reconexão forçada (`redis-cli client kill type normal`) restaurou o scheduler e o próximo disparo sozinho.

**Rate limiting conservador.** Os limites do Toddle **não são documentados**: o worker usa `concurrency: 1` + `limiter 2 req/s` — medido em 31/07, quando `concurrency 3` + `5 req/s` tomou HTTP 429 em massa e mandou 3 lotes para a DLQ. O cliente ainda retenta 429/5xx por conta própria (`ToddleClient.withRetry`, 5 tentativas, honrando `Retry-After` quando ele vem).

Mesmo assim é possível tomar 429: em 07/08, três syncs completos em ~30 min durante testes esgotaram a cota do sandbox. Dois sinais úteis: o Toddle **não** manda `Retry-After`, então o fallback exponencial cobre só ~15s; e syncs em sequência próxima somam contra a mesma janela. Se isso aparecer em produção, o ajuste é alargar o backoff do cliente, não subir o limiter.

**Falha de rede também é retentada** (corrigido em 10/08/2026). O cliente retentava 429/5xx mas desistia na primeira tentativa quando não havia resposta HTTP — e erro de rede é justamente isso. Nas noites de 08 a 10/08 o sync acumulou **52 falhas de transporte contra 15 de rate limit**: cada reset de TCP ou blip de DNS matava um aluno definitivamente e derrubava lotes inteiros para a DLQ. O discriminador é seguro porque erro de negócio sempre vem com status; sem status, é transporte. `4xx` que não 429 continua subindo na hora.

**`sourceId` imutável.** `SOURCE_ID_PREFIX` + código de negócio do RM (RA). Escolha o formato uma única vez (ex.: `1-` para a coligada 1) e nunca mude — ele é o contrato de identidade entre os sistemas.

**`XxxCode` vs `XxxInternalId`.** O mapeamento usa sempre o **Code** (RA, chapa, código de turma). O `InternalId` é chave técnica do RM: guardamos apenas como referência (`rm_internal_id`) e jamais o montamos manualmente.

## Ambiente — leia antes de avaliar risco

**As duas pontas são SANDBOX.** O `escolaamericana143994.rm.cloudtotvs.com.br` e a
organização Toddle `404045532130986859` não são o RM nem o LMS de produção da EAV.

Isso muda como se lê o que está aqui:

- **Dado velho ou vazio é dado de teste, não incidente.** Nada foi lançado no RM
  depois de 22/07/2026; num sandbox isso não é alarme.
- **"Não sobrecarregar o ERP de produção" não é argumento válido** neste ambiente.
  Onde ele apareceu em decisão de arquitetura, foi corrigido — a decisão precisa se
  sustentar por outro motivo ou cai.
- **A irreversibilidade das APIs do Toddle continua valendo**, porque é propriedade
  da API e não do ambiente: aluno, staff e turma só arquivam; timetable slot e
  teacher course não têm nem isso. Sujeira criada aqui também não se apaga.
- **As ressalvas de governança** (data de corte da D1, grading periods, política de
  escrita) seguem em `docs/DECISOES.md` como **requisito para quando existir
  produção** — não como descrição do que está no ar.

Quando houver produção, o checklist de onboarding do D-calendário vale integralmente:
calendário certo **na criação**, porque o ano corrente não é editável.

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

# 6. Agendamentos noturnos (alunos e professores), tz America/Sao_Paulo
npm run schedule            # idempotente; opcional — o worker também registra

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
quando a máquina acorda, não às 3h. Para produção, ver a seção do Coolify abaixo.

### Backup do Postgres de produção

Duas camadas, porque cada uma cobre um risco diferente:

**1. Backup agendado do Coolify** (`0 4 * * *`, configurado na UI do recurso PostgreSQL). Grava no disco do **próprio servidor** — protege contra `DELETE` errado, migration ruim e restore malfeito. Não protege contra perder a máquina.

**2. `scripts/pull-backup-coolify.sh`** — puxa o dump para esta máquina por SSH, tirando a cópia de fora do servidor. Existe porque não há S3 configurado (`No validated S3 Storages found`), e configurá-lo exige decidir provedor e onde o dado de responsáveis pode morar.

```bash
# .env (gitignored) — ou variáveis de ambiente
COOLIFY_SSH_HOST=usuario@servidor
COOLIFY_PG_CONTAINER=<nome>   # ssh HOST 'docker ps --format "{{.Names}}"' | grep -i postgres

./scripts/pull-backup-coolify.sh          # manual
cp scripts/com.escolaamericana.rm-toddle.pull-backup.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.escolaamericana.rm-toddle.pull-backup.plist
```

O dump é **streamed** pelo SSH, não gerado em arquivo no servidor e copiado depois: o `rm_code` dos 219 `PARENT` são e-mails de responsáveis, e arquivo temporário em disco alheio é dado pessoal esquecido. Saída em `backups/coolify/` com `chmod 600`, retendo 14 dumps.

**Um backup não verificado não é backup.** O script recusa o resultado em quatro situações, todas testadas: `ssh`/`pg_dump` com erro, arquivo abaixo de 20KB, gzip corrompido, e — a que pega o caso traiçoeiro — **dump grande mas sem nenhuma linha de `id_mapping`**, que um cheque de tamanho sozinho deixaria passar. Note que o mínimo é medido no arquivo **já comprimido**.

### Deploy no Coolify

`Dockerfile` + `docker-compose.coolify.yml` (não confundir com o `docker-compose.yml`
da raiz, que é a infra de desenvolvimento). Redis e Postgres são **recursos
gerenciados do Coolify**, criados pela UI — o Postgres ganha backup agendado, que
não existe em nenhum outro lugar hoje.

```
init     migrations + npm run schedule, roda a cada deploy e sai (ambos idempotentes)
worker   sem porta, sem domínio, 1 réplica  <- o que fecha a lacuna do agendamento
api      expõe 3333 só na rede interna, alcançada apenas pelo nginx do web
web      nginx com o estático do Vite + proxy /api -> api:3333; ÚNICO com domínio
```

Passos:

1. Criar o projeto e adicionar os recursos **PostgreSQL** e **Redis**; ativar backup no Postgres.
2. Adicionar a aplicação apontando para este repo, tipo **Docker Compose**, arquivo `docker-compose.coolify.yml`.
3. Preencher as variáveis (a lista completa está no cabeçalho do compose). `DATABASE_URL` e `REDIS_URL` saem da UI dos recursos.
4. Ligar o domínio **só no serviço `web`**.
5. Deploy. O `init` roda as migrations e registra o cron antes de o worker subir.

**Depois de mexer em variável, rode `./scripts/comparar-env.sh`.** Ele compara o `.env` local com o `printenv` do container em produção — o ambiente que o processo **realmente vê**, não o que a UI do Coolify mostra. Se você salvou a variável e não redeployou, é este script que conta a verdade.

Existe porque em 10/08 eu adicionei `RM_SENTENCA_TURMADISC` no `.env` local e esqueci em produção: o `staff.sync` rodou às 03:30, morreu nas 3 tentativas e foi para a DLQ. O erro era ruidoso e nomeava a variável — mas ninguém estava olhando às 3h.

Ele classifica por **consequência**, não por diferença, senão viraria ruído (produção difere de local em `DATABASE_URL`, `REDIS_URL`, `NODE_ENV` por desenho):

- **alerta** — falta em produção e não há default, ou é chave **crítica**. `SOURCE_ID_PREFIX` está na lista de críticas mesmo tendo `.default('')`: prefixo vazio faz o middleware criar **253 alunos duplicados**, e ter default não significa que o default serve.
- **aviso** — só em local, mas o schema tem default: produção roda com o default.
- **por design** — infra/ambiente e derivadas (`TODDLE_BASE_URL` sai de `TODDLE_REGION`).

Valor de chave sensível é comparado por hash; o script nunca imprime segredo. Sai com código 1 quando há alerta, então serve em pipeline.

**Marque as variáveis como "Runtime only" no Coolify** — desmarque "Available at
Buildtime" em todas. Nenhuma é necessária no build, e há duas razões:

1. `NODE_ENV=production` chegando ao build faz o `npm ci` **omitir as
   devDependencies**, onde vivem `typescript`, `tsx` e `vite`. Foi o que derrubou
   o primeiro deploy (07/08 13:55, `npm run typecheck` com exit 127). O
   `npm ci --include=dev` no Dockerfile já protege contra isso, mas não há por
   que injetar a variável no build de qualquer forma.
2. `RM_WS_PASS` e `TODDLE_TOKEN` estavam sendo passados como `--build-arg`.
   Segredo em build arg é exposição desnecessária — eles só fazem sentido em
   runtime.

Quatro coisas que quebram silenciosamente se você mudar:

- **Réplicas do worker têm de ser 1.** O limiter do BullMQ é por worker (2 req/s); duas réplicas viram 4 req/s e o Toddle devolve 429 em massa. Escalar não acelera nada.
- **Healthcheck do worker não pode ser de porta** — ele não responde HTTP, e um check default reiniciaria o container em loop.
- **O worker precisa de TODAS as variáveis**, inclusive `GOOGLE_CLIENT_ID` e `GOOGLE_ALLOWED_HD`, porque o Zod valida o schema inteiro no start. Faltando uma, ele aborta em vez de subir pela metade.
- **`API_HOST=0.0.0.0` no serviço `api`.** O default `127.0.0.1` só aceitaria conexão do próprio container e o nginx não alcançaria. É seguro porque o serviço não publica porta no host.

`NODE_ENV=production` **proíbe** `API_AUTH_MODE=localhost` no Zod — o modo sem login não sobe em produção nem por engano.

Verificado localmente: as imagens `runtime` e `web` constroem, o typecheck roda dentro do build (erro de tipo derruba o deploy) e o worker sobe no container conectando em Redis e Postgres. **Não testado** contra o Coolify real — falta confirmar que a CloudTOTVS aceita o IP do servidor novo.

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

  **O bloqueio deixou de ser infraestrutura e passou a ser governança acadêmica.** Não porque *este* RM seja crítico — ele é sandbox (ver "Ambiente") — mas porque em produção o RM é o sistema de registro legal da escola, e a política tem de existir antes de a via de escrita ser ligada lá. Antes de qualquer escrita: definir o que o Toddle está autorizado a lançar, quem aprova, qual a unidade oficial de frequência, e a política de conflito Toddle × RM. Sonda de escrita sem persistir dado: `docs/rm-sentencas/testar-saverecord.sh`.
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
