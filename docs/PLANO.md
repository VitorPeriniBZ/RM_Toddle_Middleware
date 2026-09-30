# Plano priorizado — 29/09/2026

Base: `docs/AUDITORIA.md` (FASE 1).

## Janela de deploy — main congelada em 30/09

**Decisão: o deploy tem prioridade sobre o P1 restante.** Registrada aqui
porque inverte a ordem que vinha sendo seguida, e a razão não é conveniência:

1. **As proteções construídas valem zero até rodar.** Quatro caminhos de
   escrita fechados, canal de alerta, canário, duas sombras — nada disso
   existe em produção.
2. **O lote do primeiro deploy cresce a cada merge.** Um deploy grande é mais
   difícil de diagnosticar quando algo sai errado, e este já tem 4 itens P1
   além do bloco P0.
3. **A cópia de base é gatilho periódico.** Ela aconteceu em 13-15/08, 16/09 e
   20/09. Cada ciclo sem canário é exposição ao evento que o canário existe
   para pegar.
4. **O risco do deploy é baixo e conhecido:** nenhuma migration, rollback é só
   código (`827c2ac`), e as duas flags de falha alta estão em `false` (sombra).

**Regra até a verificação pós-deploy terminar: nada mergeia em `main`.**
Branches podem avançar; merges não. O candidato é `420bae9`.

### Estado do candidato, verificado em 30/09

| verificação | resultado |
|---|---|
| `npm run lint` | limpo |
| `npm run typecheck` | limpo |
| `npm test` | **565 verdes**, 35 arquivos |
| `npm run checar:config` | passa |
| `npm run canario` | saída 0, as seis Sentenças conferem (RM real) |

---

## Decisão de orçamento: `noUncheckedIndexedAccess` fica DESLIGADA (P1-C, 30/09)

Medido, não estimado — a flag foi ligada temporariamente só para contar:

| escopo | erros |
|---|---|
| repositório inteiro | **253** |
| `packages/domain` | 98 |
| `packages/db` | 77 (repositórios e `.itest`, não tocam chave do RM) |
| `apps/worker` | 62 — **29 deles em dois scripts one-off** que o P2 arquiva |
| resíduo (`config`, `integrations`, `queues`, `api`) | 16 |

Parcela significativa é **falso positivo**: `chaveCourse.ts:79` é
`const [a,b,c] = partes` depois de `partes.length !== 3` — o TypeScript não
estreita destructuring por checagem de `length`. Consertar isso é ruído.

**E o argumento decisivo: a flag não pegaria nenhum dos dois defeitos reais.**
`String(row.CODETAPA)` compila sob ela, e template literal com campo cru
também. Os dois estão fora dos 253.

### O critério que fica registrado

> **O detector da classe que causou dano tem prioridade sobre defesa em
> profundidade. Orçamento para uma coisa só → o detector.**

A flag entrega higiene de tipos e profundidade em OUTRAS classes. Se entrar
depois, é item próprio de higiene — não urgência, e com o custo já medido acima.

### Nomeação das chaves inline: item próprio, junto do P1-E

As 8 chaves inline são invisíveis para auditoria por token. Nomeá-las
(`chaveProvaEtapa`, `chaveEtapaNota`, …) as tornaria pesquisáveis e testáveis —
mas é refatoração em caminho de escrita, que a regra do P1-E cobre com rede.
Vai junto de lá, não aqui.

---

## Mapa do padrão `?? ''` no projeto — levantado no P1-A (30/09)

O registrado era "o leitor de notas não foi auditado". A varredura mostrou que
o padrão aparece em **38 lugares** no `packages/domain`, e que a maioria é
inofensiva. O que separa o inofensivo do perigoso é uma pergunta só:
**o valor alimenta a chave natural de um caminho que escreve no RM?**

O RM é o registro acadêmico oficial. Escrita lá é irreversível — a proveniência
só guarda o que NÓS criamos, então o valor do professor não tem backup.
Escrita no Toddle é recuperável: o RM continua sendo a fonte.

| fonte | `?? ''` | alimenta a chave? | destino da escrita | risco | estado |
|---|---:|---|---|---|---|
| `rmAttendanceSource` | 6 | **SIM** (`idTurmaDisc`, `idHorarioTurma`) | **RM** (falta no diário) | **irreversível** | **corrigido no P0-6** |
| `rmGradeSource` | 7 | **SIM** (`codEtapa`) | **RM** (nota no boletim) | **irreversível** | **corrigido no P1-A** |
| `rmTeacherSource` | 10 | não — rótulos de turma, disciplina, segmento, nome | Toddle | baixo | follow-up |
| `rmGuardianSource` | 2 | não — nome do aluno, parentesco | Toddle | baixo | follow-up |
| `rmAssessmentTargets` | 1 | não — `descricao` da avaliação | RM (via `sincronizarAvaliacoes`) | **a verificar** | follow-up |
| `rmGradeTargets` | 1 | não — dentro do helper `ehSim` | — | nenhum | ok |
| `rmWriteDecision` | 1 | não — normalização dentro de `hashValor` | — | nenhum, é correto |

### Correção do mapa, feita no P1-B (30/09)

Duas linhas da tabela acima estavam erradas, e a verificação as derrubou:

**`reconciliarTurmas` NÃO escreve no RM.** Eu o listei como caminho de escrita
por ele *importar* `wsDataServerClient`. Tem **zero** `saveRecord`: usa só
`readView`, e o próprio cabeçalho do arquivo explica por quê — *"detectar a
deriva, não corrigi-la"*, porque o Toddle não tem DELETE de turma e uma turma
criada por engano não se desfaz. O `String(r.CODTURMA ?? '')` dele alimenta
`chaveCourse`, que **já lança** em segmento vazio, com mensagem nomeando o
campo e 13 testes. Nada a consertar.

**São TRÊS caminhos de escrita irreversível, não quatro:**

| caminho | DataServer | estado |
|---|---|---|
| `sincronizarFrequencia` | `EduFrequenciaDiariaWSData` | fechado no P0-6 |
| `sincronizarNotas` | `EduNotasData` | fechado no P1-A |
| `sincronizarAvaliacoes` | `EduProvasData` + `EduNotasData` | **fechado no P1-B** |

### `sincronizarAvaliacoes` — um `?? ''` pior que o `?? ''`

A ocorrência que o mapa marcava como "risco a verificar" era `DESCRICAO`, um
rótulo. Mas a auditoria achou outra coisa, mais grave e de outra família.

Este caminho monta a chave a partir de `readView`, cujo tipo é
`DataServerRow = Record<string, string>`. Sem `noUncheckedIndexedAccess` — que
este projeto não liga —, o índice **mente**: o TypeScript promete `string` até
para chave inexistente. Em runtime, `String(row.CODETAPA)` de um campo ausente
devolve **`"undefined"`**.

Pior que `''` por um motivo específico: `1|undefined|1|N|1714|RA` tem cara de
chave válida num log, e qualquer guarda de "está vazio?" a deixa passar.

**Consertado com `throw`, sem flag nem sombra — e a diferença é justificada:**
os outros dois ganharam período de sombra porque o gatilho é recorrente (a
Sentença some a cada cópia de base). Aqui **não há Sentença**: o schema do
DataServer é do produto TOTVS. E foi medido — 245 linhas de `SProvas`, 3.507 de
`SNotas`, **zero** componentes ausentes ou vazios. Sombra existe para reunir
evidência; aqui ela já está reunida.

`chaveCourse` já lançava assim desde antes. Seguir um padrão existente vale
mais que inventar um terceiro.

### O terceiro caminho ganhou o sinal que o P0-5 deixou de fora

`avaliarCruzamento` estava em frequência e notas. Avaliações ficou sem, com a
justificativa de que `alvos.notasPorChave` tinha origem fora daquele escopo. A
origem foi auditada aqui, então o caminho que escreve em `EduProvasData` e
`EduNotasData` deixou de ser o único sem checagem cruzada — e ganhou também a
trava `naoEscreveu: 'cruzamento-suspeito'`.

### Follow-ups, por classe de risco

1. ~~`rmAssessmentTargets` / `sincronizarAvaliacoes`~~ — **fechado no P1-B.**
2. ~~`reconciliarTurmas`~~ — **não é caminho de escrita.** Verificado: zero
   `saveRecord`, e `chaveCourse` já lança em segmento vazio.
3. **`rmTeacherSource` e `rmGuardianSource`** — escrita no Toddle, recuperável.
   As 12 ocorrências são rótulos; um rótulo vazio empobrece a tela, não destrói
   registro. **Prioridade: baixa, e é a única que resta.**
4. **`noUncheckedIndexedAccess` desligado no `tsconfig.json`** — achado do
   P1-B. É a causa-raiz do `String(undefined)`: o índice de
   `Record<string, string>` promete `string` para chave que não existe. Ligá-lo
   acharia a classe inteira de uma vez, em vez de caso a caso. **Custo: alto** —
   35 mil linhas, e o compilador passaria a exigir guarda em todo acesso
   indexado. Item próprio, não follow-up deste.

**Os três caminhos de escrita irreversível estão fechados.** O que resta é de
classe de risco menor.

---

## Consolidação em `main` — 30/09/2026

**O bloco P0 + o hotfix P1-0 estão em `main` e no remoto. NÃO estão em
produção** — o deploy é manual. Ver `docs/DEPLOY.md`.

### Topologia encontrada, antes de alterá-la

As sete branches eram uma **cadeia linear**: cada uma foi criada sobre a ponta
da anterior, não a partir de `main`. Verificado com `git merge-base
--is-ancestor` em todos os sete pares consecutivos.

```
827c2ac (main)  →  p0-1  →  p0-2  →  p0-3  →  p0-4  →  p0-5  →  p0-6  →  p1-0
                                                                        16 commits
                                                                        0 merges
```

Consequência: **não houve integração divergente**. Os `--no-ff` existem para
marcar a fronteira de cada item no histórico de `main`, não para combinar
trabalhos paralelos — e por isso não houve conflito nenhum para resolver.

### Estado integrado verificado em `main`, não por branch

| verificação | resultado |
|---|---|
| `npm run typecheck` | limpo |
| `npm test` | **510 verdes**, 32 arquivos |
| `npm run checar:config` | passa |
| `npm run alerta:testar` | saída 1 — sem canal é estado declarado, não defeito |
| `npm run canario` | saída 0, as seis Sentenças conferem (contra o RM real) |
| `/health` com dependências fora | **200** em 3ms |
| `/health/ready` com dependências fora | **503** em 6ms, corpo por dependência |

Nenhuma migration foi adicionada: o schema não mudou, e o rollback é só de
código (`827c2ac`).

### A sombra do P0-6 ainda NÃO começou a contar

O relógio parte do **primeiro cron de frequência (23h) pós-deploy**, que roda
no WORKER. Merge não é deploy. Critério de ativação do estrito inalterado: 7
observações limpas **+ decisão humana** — e ativar reabre junto a revisão do
alerta-apenas do canário.

---

## Progresso da execução (FASE 3)

| Item | Estado | Commits |
|---|---|---|
| P0-1 Congelar a chave natural em teste | **concluído** 29/09 | `520b9c2`, `d203c20` |
| P0-2 Ligar o canal de alerta | **concluído** (código) 29/09 | `40462e1`, `+hardening` |
| P0-3 Readiness honesto (`/health/ready`) | **concluído** 29/09 | `c97316a`, +P0-3 |
| P0-4 Canário de Sentenças | **concluído** 29/09 (M→S) | ver commit do canário |
| P0-5 Sinal de cruzamento (vereditos + colisão) | **concluído** 29/09 | ver commit do sinal |
| P0-6 `?? ''` → falha alta, em SOMBRA | **concluído** 29/09 (sombra ativa, estrito desligado) | ver commit da falha alta |

Suíte: 328 → 417 testes verdes. `typecheck` limpo. `checar:config` passa.

**P0-2 depende de ação humana para ficar completo de ponta a ponta**: as URLs de
webhook e heartbeat são contas do usuário. Ver `docs/TODO.md` §1.

Esforço em unidades relativas: **S** (uma sessão), **M** (algumas sessões), **L** (dias).

---

## 1. O que a verificação mudou no esqueleto proposto

O esqueleto de priorização foi validado contra o código. Quatro mudanças, todas
justificadas. Nada foi descartado sem motivo.

### 1.1 O sinal de worker muda de "construir" para "ligar" — e o achado é grave

O esqueleto pede *"sinal de worker não está consumindo: health check baseado em
last-processed-job / queue lag"*. **Isso já existe e está escrito melhor do que o
esqueleto propõe.**

`apps/worker/src/agenda/vigia.ts` — `vigiarUmaVez()` faz exatamente as três
perguntas certas, e o cabeçalho diz que foi escrito para o incidente dos 62 jobs:

1. algum fluxo LIGADO está sem run **bem-sucedido** além da janela dele?
   (janela por fluxo em `packages/queues/src/fluxos.ts`: 13h para alunos,
   professores, turmas e frequência; **4h** para notas)
2. tem algo na DLQ?
3. tem run preso em `executing` há mais de 6h?

Está ligado de fato: `ligarVigia` é importado em
`apps/worker/src/workers/rm-to-toddle/studentSync.worker.ts:7` e roda num timer.
E existe o dead man's switch externo em `packages/config/src/heartbeat.ts`,
desenhado exatamente para o caso "o processo que deveria alertar é o que morreu".

**O problema é que nada disso pode falar.** Verificado no `.env` real (38 chaves):

```
ALERTA_WEBHOOK_URL          AUSENTE
HEARTBEAT_URL_ALUNOS        AUSENTE
HEARTBEAT_URL_PROFESSORES   AUSENTE
HEARTBEAT_URL_NOTAS         AUSENTE
HEARTBEAT_URL_FREQUENCIA    AUSENTE
VIGIA_INTERVALO_MS          AUSENTE
```

E o código trata ausência como desligamento deliberado, silenciosamente:

- `packages/config/src/alerta.ts:56` — `if (!env.ALERTA_WEBHOOK_URL) return false;`
- `packages/config/src/heartbeat.ts:47` — `if (!url) return;`

Logo: **o vigia roda, encontra o problema, chama `alertar()`, e `alertar()` devolve
`false` sem dizer nada.** Toda vez. Foi por isso que 62 jobs ficaram 7 dias parados,
e por isso que o worker do launchd martelou um Redis morto por 13 dias.

O item deixa de ser "construir um detector" e passa a ser **"ligar o canal e fazer
o estado desligado gritar"** — muito menor e muito mais valioso. Vira o **P0-2**,
pela razão de ordem da seção 3.

### 1.2 ESLint cai de P0 para P1 — pela sua própria regra

A regra que você definiu: *"um item sem forma de detecção de falha em produção não
pode ser P0"*.

ESLint é um portão de CI. Não existe sinal em produção para "o ESLint regrediu" —
o que existe é o CI vermelho, que é detecção em *integração*, não em produção.
Aplicando a regra literalmente, ele não pode ser P0.

Isso **não** rebaixa o argumento que o justificava (produção roda `tsx`, o typecheck
é a única barreira). Ele continua sendo o primeiro item de P1.

### 1.3 Dois itens novos, que o esqueleto não tinha

**Alerta sobre a distribuição de vereditos.** `resumirDecisoes`
(`packages/domain/src/rmWriteDecision.ts:250`) já conta `porVeredito`, e esse
contador já circula nos quatro caminhos de escrita — em
`sincronizarFrequencia.ts:320` e de novo em `:425`, dentro do resultado do run.
Se `chaveNaturalRm` quebrar em silêncio, `ESCREVER_NOVO` salta para ~100% num fluxo
que roda há meses. **O detector do risco central já está calculado e ninguém olha
para ele.** Falta um limiar e uma chamada a `alertar()`.

Isto é mais forte que o teste da chave (P0-1): o teste pega a regressão de código; este
pega o modo de falha **original**, inclusive quando a causa é a Sentença mudar no
RM sem ninguém tocar em código.

**`/health` não consegue falhar.** `apps/api/src/app.ts:294` sempre devolve 200 —
não há `reply.code()`. O healthcheck do Coolify é
`wget -qO- http://127.0.0.1:3333/health || exit 1`
(`docker-compose.coolify.yml:183`), que só falha se o HTTP falhar. **Um container
com o Postgres fora é reportado como saudável.** É S de esforço e é a base sobre a
qual qualquer detecção por health check se apoia.

### 1.4 O item de frontend encolhe — corrigi um erro meu

A FASE 1 afirmou que `Auditoria.tsx` não tinha estado de erro e que três painéis não
tinham estado de carregando. **Estava errado**: a heurística contava a palavra "erro"
e não enxergou a delegação. Reconferido painel a painel, **os 6 painéis tratam erro**
via a prop `aoErrar` para `App.tsx`. `docs/AUDITORIA.md` foi corrigida.

As lacunas reais, recontadas:
- `DePara.tsx` (393 linhas) — sem estado de carregando.
- `Sentencas.tsx` — sem estado de vazio.
- **8 dos 11 campos de formulário sem rótulo** (`Acessos` 2, `Agenda` 2, `Sentencas` 1).
- **Zero media queries** no projeto (`@media`, `clamp`, `minmax`, `vw`: 0 ocorrências).

### 1.5 Um item do conselho da FASE 1 que a verificação derrubou

O conselho sugeriu, como um dos 5 primeiros testes, garantir que `SENT_UNKNOWN` não
vira retry cego. **Verificado: já não vira.**
`wsDataServerClient.ts:474-481` devolve `{ ok:false, desconhecido:true }` em timeout
em vez de lançar, e os chamadores roteiam para `desconhecidas`
(`sincronizarFrequencia.ts:193`, `sincronizarNotas.ts:166`). Um teste ali seria de
**caracterização** (congelar o comportamento correto), não correção — por isso é P2,
não P0.

---

## 2. Matriz impacto × esforço

A última coluna é obrigatória em P0 e P1.

### P0 — o dado do aluno, e a capacidade de ver que algo quebrou

| # | Item | Impacto | Esforço | Prior. | Como detectar que quebrou em produção |
|---|---|---|---|---|---|
| **P0-1** | **Congelar a chave natural em teste.** Testes de caracterização que fixam a string de `chaveNaturalRm` exatamente como é hoje (ordem dos 5 segmentos, `Number(f.codColigada)`), mais um teste de que `chaveNaturalDeFalta` continua **chamando** `chaveNaturalRm` em vez de reimplementá-la. **Só CI, não toca produção.** | Crítico | S | P0 | Não se aplica — é rede para os itens seguintes. É o primeiro exatamente por isso: congela o comportamento antes que alguém o altere. |
| **P0-2** | **Ligar o canal de alerta.** Definir `ALERTA_WEBHOOK_URL` e os 4 `HEARTBEAT_URL_*`; fazer o estado "desligado" **gritar**: `error` no boot do worker e da API, campo `alertas: 'ativo' \| 'DESLIGADO'` no `/health`, e `npm run alerta:testar`. O avaliador do heartbeat tem de ser **externo ao processo** (Healthchecks.io/Uptime Kuma) — o desenho de `heartbeat.ts` já é esse. | Crítico | S | P0 | **Alerta sintético com resposta observável**: `npm run alerta:testar` chega no canal; um teste agendado semanal, porque canal mudo há 7 dias é indistinguível de canal quebrado. Teste de aceite: matar o worker em homologação e cronometrar o alerta. |
| **P0-3** | **`/health/ready` NOVO, com 503 por dependência fora.** `/health` PERMANECE sempre 200 (liveness) e o healthcheck do Coolify não muda — ver "decisões negadas" §4.5. `limitado` não derruba prontidão. Cada checagem corre contra um prazo de 3s. | Alto | S | P0 | **Não é mais o reinício do container** (ver §4.5): a detecção é (a) alerta pelo canal do P0-2, com assunto estável e janela de 30 min, e (b) `/health/ready` devolvendo 503 para um monitor externo. Verificação feita: API no ar com Postgres e Toddle inalcançáveis → `/health` 200, `/health/ready` 503 em 3ms, um único alerta. |
| **P0-4** | **Canário de Sentenças — AGENDAR o que já existe.** A exploração derrubou as premissas do item: `conferir()` já faz as três camadas (corpo vs `.sql` caractere a caractere, execução com `colunasAusentes`, volume), o manifesto já existe, e `INFORMATION_SCHEMA` é a ferramenta errada (Sentença é query salva, não tabela). Faltava só agendar e alertar. **M → S.** Cadência: corpo de hora em hora, execução 1×/dia — ver abaixo. | Crítico | ~~M~~ **S** | P0 | É ele próprio um detector, e o **único que avisa antes** de um run começar a processar. Que ele quebrou se detecta pelo alerta sintético do P0-2 e por `npm run canario` (saída 0 confere / 1 divergente / 2 não verificada). |
| **P0-5** | **Sinal de cruzamento.** NÃO virou limiar de porcentagem: numa primeira execução 100% de `ESCREVER_NOVO` é o certo, e um limiar confundiria "primeira vez" com "a trava desligou". O discriminador é a CONTRADIÇÃO — "o RM tem N linhas e ZERO casou" — mais um segundo sinal aritmético e independente: linhas lidas vs chaves únicas (colisão faz linha sumir do índice sem mexer na distribuição). Ligado em frequência e notas. | Crítico | S | P0 | É ele próprio o detector, e é o único que pega o modo de falha **original**: a proteção desligando sem exceção, sem DLQ e com o relatório bonito. A distribuição vai para o log em TODA passada, suspeita ou não — é o que constrói a baseline que hoje não existe. |
| **P0-6** | **Trocar o `?? ''` por falha alta**, no **leitor**. A execução separou o que o `?? ''` confundia: **coluna ausente do result set** (drift da Sentença, vale para todas as linhas → detectada UMA vez antes do laço, aborta o run) × **valor vazio numa linha** (registro incompleto → descarta a linha, como `DATA` ilegível já fazia). Flag `FALHA_ALTA_COLUNA_AUSENTE_FREQUENCIA` (renomeada no P1-A, quando notas ganhou a sua), default `false` = **sombra**. | Crítico | M | P0 | Em sombra: `error` no log + alerta com assunto estável, e o run segue. Em estrito: run abortado com a coluna nomeada → job vermelho → DLQ → webhook. **Medido no result set real (29/09): 698 linhas, 23 colunas, nenhuma coluna da chave ausente — a sombra está silenciosa hoje.** |

### P1 — as barreiras que faltam

| # | Item | Impacto | Esforço | Prior. | Como detectar que quebrou em produção |
|---|---|---|---|---|---|
| **P1-1** | **ESLint (typescript-eslint strict) + Prettier no CI.** Regras que importam aqui: `no-floating-promises`, `no-misused-promises`, `require-await`, `no-empty`. | Alto | M | P1 | *Não há detecção em produção* — é por isso que saiu do P0 (seção 1.2). O sinal é o CI vermelho. Declarado explicitamente para não fingir que existe. |
| **P1-2** | **Rotação de log + teto de retry de conexão do ioredis.** Hoje: 6,3 GB, ~1 GB/dia, `scripts/worker-students.sh` sem rotação, plist redirecionando direto para os arquivos. | Alto | S | P1 | Alerta de disco (>80%) e um check de tamanho do diretório `logs/` no `preflight`. Detecção direta: o arquivo parar de crescer. |
| **P1-3** | **Testes de `exigirPapel` e do hook CSRF.** Tabela papel × rota (403 onde deve negar) **+ teste de inventário**: toda rota registrada fora de `/health` e `/auth/config` passa por `exigirPapel` — protege a rota nº 28 contra o esquecimento. | Alto | M | P1 | Sem detecção em produção por desenho: uma falha de autorização é silenciosa até ser explorada. Por isso o teste de **inventário** importa mais que o de tabela — ele falha no CI quando alguém adiciona rota sem papel. |
| **P1-4** | **Preencher `packages/contracts`** (84 linhas hoje): schemas Zod por rota, usados como schema do Fastify na API e como tipo em `apps/web/src/api.ts`. | Alto | L | P1 | 400 com corpo estruturado em vez de comportamento indefinido. Detecção: taxa de 400 por rota no log — hoje payload inválido não produz sinal nenhum. **Breaking change potencial — ver seção 5.** |
| **P1-5** | **`@fastify/helmet` + `@fastify/rate-limit`** (global + limite menor nas rotas de escrita). | Médio | M | P1 | Contador de 429 emitidos pela nossa API no log. **Risco de execução alto — ver seção 6.** |
| **P1-6** | **Rodar a suíte `.itest.ts` no CI** com um serviço Postgres. É cobertura já escrita e já paga que ninguém executa, e é o único lugar do projeto que exercita migrations, `CHECK`s e a transação de `audit_event` de verdade. Custo próximo de zero comparado ao ESLint. | Alto | S | P1 | CI vermelho. O sinal em produção que ela substitui hoje é nenhum. |
| **P1-7** | **`npm audit --audit-level=high` e build da imagem no CI.** Hoje o CI não roda nenhum dos dois; `Dockerfile` quebrado só aparece no deploy manual. | Médio | S | P1 | CI vermelho. Em produção, o sinal de que faltou é o deploy falhar — que é exatamente o que este item evita. |
| **P1-8** | **Teste de caracterização do delta em `sincronizarFrequencia.ts`.** Dado estado RM + estado Toddle, quais faltas são criadas, mantidas e recusadas. Caso obrigatório: origem vazia ou parcial **não** produz remoção. | Alto | M | P1 | O **P0-5** (alerta de veredito) é o detector em produção deste comportamento. O teste congela o que o P0-5 mede. |
| **P1-9** | **Frontend**: estado de carregando em `DePara.tsx`; estado de vazio em `Sentencas.tsx`; rótulo nos 8 campos sem; media queries (não há nenhuma). **Design tokens de `estilos.ts` ficam como estão** — já são bons. | Médio | M | P1 | Sem detecção automática. Mitigação: checklist de revisão e um teste de render por painel (hoje `apps/web` tem zero). |
| **P1-10** | **Quebrar os arquivos grandes**: `app.ts` (434), `rotas/agenda.ts` (590), `studentSync.processor.ts` (474) → alvos < 300 linhas. | Médio | L | P1 | Nenhuma mudança de comportamento é esperada — e é justamente isso que torna o item arriscado sem P0-1, P0-6, P1-3 e P1-8 no lugar. **Depende deles.** |

### P2 — dívida operacional

| # | Item | Impacto | Esforço | Prior. |
|---|---|---|---|---|
| P2-1 | Arquivar os 33 scripts one-off em `apps/worker/src/scripts/archive/` com README de origem e data; tirar da raiz do `package.json` os que não são operação corrente | Médio | M | P2 |
| P2-2 | `docs/RUNBOOK.md` usando o incidente do launchd como caso real: RM/Toddle/Redis/PG fora, `dlq`, `preflight`, `pendencias`, `runs` | Médio | M | P2 |
| P2-3 | Reagrupar `.env.example` por contexto (API/AUTH/RM/TODDLE/DB/REDIS/ALERTA). A documentação existe e é boa; está só desorganizada | Baixo | S | P2 |
| P2-4 | Teste de caracterização de `SENT_UNKNOWN` (congelar o comportamento, que já está correto — seção 1.5) | Baixo | S | P2 |
| P2-5 | Teste de `idMappingRepository` (420 linhas, único repositório sem `.itest.ts`) | Médio | M | P2 |

### P3 — acabamento

| # | Item | Impacto | Esforço | Prior. |
|---|---|---|---|---|
| P3-1 | Cache do health do Toddle: **documentar** que é single-instance, não migrar para Redis. O comentário em `app.ts:91-98` já argumenta que vivacidade do processo não deve ser compartilhada, e o argumento está certo | Baixo | S | P3 |
| P3-2 | Enxugar o `README.md` (37 KB) para o essencial, detalhes para `docs/` | Baixo | M | P3 |
| P3-3 | OpenAPI gerado a partir dos schemas do P1-4 | Baixo | M | P3 |

---

## 3. Dependências entre itens

```
P0-1 (congelar a chave em teste)  ── só CI, risco zero, por isso vem primeiro
  └──> P0-6  (é a rede que torna seguro mexer no leitor)

P0-2 (ligar o alerta)
  │   é o CANAL. Sem ele, todo item cuja detecção é "alerta" entrega o alerta
  │   a ninguém — que é literalmente o incidente dos 62 jobs e o do launchd.
  ├──> P0-4  (o canário precisa de canal)
  ├──> P0-5  (o alerta de veredito precisa de canal)
  ├──> P0-6  (o job vermelho precisa virar aviso humano)
  └──> P1-2  (alerta de disco)

P0-3 (/health pode falhar)
  └──> precondição para confiar em qualquer detecção por health check,
       inclusive no reinício automático do Coolify

P0-4 (canário de colunas) + P0-5 (alerta de veredito)
  └──> juntos cobrem os dois tempos do mesmo risco: o canário avisa ANTES
       do run, o veredito avisa DURANTE. Fazer só um deixa uma janela aberta.

P0-6 (fail-high no leitor)
  └──> P1-10 (quebrar arquivos grandes) — refatorar o caminho de escrita
       antes disso é mexer na trava sem rede

P1-3 (testes de exigirPapel/CSRF)
  └──> P1-10 (quebrar app.ts move os hooks de lugar)

P1-4 (contracts)
  ├──> P3-3 (OpenAPI sai dos schemas)
  ├──> P1-9 (tipos compartilhados com o front)
  └──> P1-10 (os schemas são o que se extrai de agenda.ts — o conselho observa
        que P1-10 vira em boa parte subproduto de P1-4, não item próprio)

P1-8 (teste de delta) + P0-5 (alerta de veredito)
  └──> par teste/detecção do mesmo comportamento: um congela em CI, o outro
       observa em produção. Fazer só um é metade do trabalho.
```

**Ordem de execução resultante:**
`P0-1 → P0-2 → P0-3 → P0-4 → P0-5 → P0-6 → P1-1 → P1-2 → P1-3 → P1-6 → P1-8 → P1-4 → P1-5 → P1-7 → P1-9 → P1-10`

### Por que P0-1 (teste) vem antes de P0-2 (canal), e P0-6 (a mudança) vem depois dos dois

O esqueleto tratava "testar a chave" e "consertar o `?? ''`" como **um** item. Separá-los
resolve a tensão entre a minha ordenação e a do conselho:

- O **teste** (P0-1) não toca produção. Não há razão para ele esperar por nada, e há
  uma razão forte para vir primeiro: ele congela o formato da chave *antes* que
  alguém o altere. O conselho foi explícito — inverter isso "é a forma mais provável
  de causar exatamente o incidente que o item previne".
- A **mudança** (P0-6) transforma uma falha silenciosa numa falha ruidosa. Ruído sem
  canal vai para um log de 6,3 GB que ninguém lê. Por isso depende do P0-2.

### Onde o conselho opinou sem um fato que eu ainda não tinha

Os três conselheiros disseram que a chave natural deveria vir antes do sinal de
worker. **Eles responderam sem saber que o canal de alerta está inteiramente
desligado** — eu descobri o `ALERTA_WEBHOOK_URL` ausente *depois* de enviar o prompt.
Um deles inclusive afirma que "o webhook do `deadLetter.ts` já funciona", o que é
falso na configuração atual: `alerta.ts:56` devolve `false` antes de tentar.
A separação acima preserva o que eles acertaram (o teste primeiro) sem herdar a
premissa errada.

### Sobre `packages/contracts` subir para P0

**Não sobe — e os três conselheiros concordaram, independentemente.** Fica como
primeiro item grande de P1.

O argumento pelo que ele destrava é real e foi apontado na FASE 1 como a maior
alavancagem. Mas, nas palavras do conselho: *"o caminho de escrita acadêmica não
entra por schema de rota; entra por fila/worker. Contracts não move o risco central
em nada."* Some-se a isso:

1. Destrava **qualidade**, não **segurança do dado**.
2. É **L** de esforço e toca a superfície que o `apps/web` consome.
3. A regra da última coluna o desqualifica: sua detecção em produção ("taxa de 400
   por rota") só passa a existir *depois* de implantado.

Um ganho de sequência que o conselho apontou e eu não tinha: fazer **P1-4 antes de
P1-10** faz boa parte do P1-10 desaparecer — quebrar `agenda.ts` depois dos schemas é
extrair o que sobrou, em vez de reorganizar com cuidado uma validação manual que o
P1-4 vai apagar. A ordem acima já reflete isso.

### Cadência do canário, e por que assimétrica

Medido no código, não estimado:

| camada | custo | cadência | por quê |
|---|---|---|---|
| corpo (`executar: false`) | 6 `readRecord` do GlbConsSQLData, sem executar nada | **1 hora** (144/dia) | Pega o evento comum: Sentença apagada ou rebaixada por cópia de base. A cada ciclo do vigia seriam 576/dia — 4× a carga, para adiantar no máximo 45 min a detecção de um evento que não é sub-horário, contra um RM que este projeto já viu ficar mudo por horas. |
| execução (`executar: true`) | roda as seis; `TODDLE.NOTAS` **não aceita janela** e devolve o período inteiro (~7 mil linhas por SOAP). Só `FREQ` e `PLANOAULA` recortam 7 dias. **Medido contra o RM real: 1m10s para as seis.** | **1 dia** | Pega o drift que não muda o corpo — coluna que some por permissão. 70s/dia é desprezível; de hora em hora seriam 28 minutos de SOAP por dia contra um RM que já ficou mudo por horas. |

Configurável em `CANARIO_RELEITURA_MS` (piso 5 min) e `CANARIO_EXECUCAO_MS`
(piso 1h). Abaixo dos pisos não é vigilância, é carga.

### Linha de base medida contra o RM real (29/09)

Antes de ligar o sinal, medi o que ele veria hoje, em duas janelas:

| janela | lidas do RM | chaves únicas | perdidas | chaves com segmento vazio |
|---|---:|---:|---:|---:|
| 2026-08-24 a 28 | 810 | 810 | **0** | **0** |
| 2026-03-02 a 06 | 223 | 223 | **0** | **0** |

Três conclusões:

1. **O sinal não dispara falso hoje** — nenhuma colisão nas duas janelas.
2. **O defeito do `?? ''` ainda NÃO mordeu**: zero chaves com segmento vazio.
   A Sentença está completa agora. É a linha de base que o P0-6 protege.
3. `criadasPelaIntegracao: 0` nas 223 faltas de março — **todas lançadas por
   humano**. Se a chave degradasse, as 223 virariam `ESCREVER_NOVO` e seriam
   sobrescritas. É exatamente o dado que a trava existe para proteger, e ele
   está todo exposto a esse único ponto de falha.

### Alerta-apenas, com gatilho de revisão

O canário **alerta e não bloqueia sync**. Decisão do usuário, e a razão é que
são duas camadas de profundidade diferente: o canário detecta *drift*, o P0-6
fecha a *execução* no ponto exato em que a coluna importa. Bloquear o sync de
frequência por uma divergência que talvez não afete aquele fluxo troca um risco
por outro. **A camada rasa não decide pela profunda.**

**Fronteira, e ela é explícita:** isto vale ENQUANTO o P0-6 estiver pendente.
**Gatilho de revisão: quando o P0-6 sair do modo sombra e a falha alta for
ativada, reavaliar se o canário deve passar a bloquear.** Decisão reversível,
registrada com o gatilho para não virar permanente por esquecimento.

### Estado da sombra do P0-6 (29/09)

`FALHA_ALTA_COLUNA_AUSENTE_FREQUENCIA=false` e `FALHA_ALTA_COLUNA_AUSENTE_NOTAS=false`.
**Nenhum dos dois estritos foi ativado, e os relógios são independentes.**

Linha de base medida contra o RM real, no mesmo dia:

| medida | valor |
|---|---|
| linhas no result set (janela 02–06/03) | 698 |
| colunas devolvidas pela Sentença | 23 |
| colunas da chave ausentes | **0** |
| chaves com segmento vazio (810 e 223 faltas, duas janelas) | **0** |
| drift simulado (removendo `ID_TURMADISC`) | detectado |

**A sombra deixou de escrever.** Na primeira versão ela seguia escrevendo
("comporta-se como hoje, mas grita"). Os dois conselheiros apontaram o erro e a
assimetria decide: escrever por cima de lançamento humano é IRREVERSÍVEL — a
proveniência só guarda o que nós criamos —, e não escrever é ATRASO. A sombra
que escreve não coleta um bit a mais de informação; só adiciona o risco. Hoje
um cruzamento suspeito fecha o run com `naoEscreveu: 'cruzamento-suspeito'` e
status `succeeded` — não é job vermelho.

`avaliarVolume` quase bastava como anteparo: degradação TOTAL salta de ~40 para
~800 escritas e estoura desvio (50%) e teto de escopo (30%). Mas `abaixoDoPiso`
desarma as duas quando `aEscrever <= 50` — então a degradação PARCIAL (uma
turma, trinta faltas) passava por baixo de tudo. É esse caso que o bloqueio pega.

**Critério para ligar o estrito:** um período de sombra sem nenhum alerta de
coluna ausente. Como a cadência de frequência é diária (`FREQ_SYNC_CRON` às
23h), uma semana dá sete observações — suficiente para cobrir uma cópia de base
típica, que é o evento que o item existe para pegar.

**Quando ligar, reavaliar também o bloqueio do canário** (P0-4), que hoje é
alerta-apenas justamente porque a falha alta ainda não existia no ponto de uso.

## 4. Decisões negadas

### 4.1 Migrar o CSRF manual para `@fastify/csrf-protection` — **NEGADO**

Proposto no plano original (item 3.2). Rejeitado após consulta ao conselho na FASE 1,
onde os dois conselheiros que responderam chegaram à mesma conclusão de forma
independente, e após verificação de `apps/api/src/app.ts:172-211`.

**O que o hook atual tem:**

| Camada | Mecanismo | Por que é forte |
|---|---|---|
| 1 | `Sec-Fetch-Site: same-origin \| none` | **Preenchido pelo navegador.** Uma página atacante não consegue forjá-lo — não é um header que JavaScript possa definir. É a defesa mais forte disponível contra CSRF hoje. `same-site` é recusado de propósito: subdomínio não é esta aplicação. |
| 2 | Allowlist estrita de `Origin` vinda de `WEB_ORIGINS` | Fecha o caso em que `Sec-Fetch-Site` não vem |
| 3 | `new URL(origin \|\| referer).host === req.headers.host` | Fallback para cliente que não manda `Sec-Fetch-*` |
| 4 | Ausência de `Origin` **e** `Referer` → 403 | **Falha fechada** |
| 5 | Isenção para Bearer sem cookie | Correta: CSRF é ataque sobre credencial *ambiente*; o navegador nunca anexa `Authorization` sozinho. Mantém CI e scripts funcionando. |

**O que o double-submit cookie oferece:** um token em cookie, espelhado num header.

Por que é estritamente inferior **aqui**:

- **Não consulta `Sec-Fetch-Site`.** Abre mão da camada 1, que é a única não-forjável.
- **Não consulta allowlist de origem.** Abre mão da camada 2.
- **O cookie do token precisa ser legível por JavaScript** para o cliente espelhá-lo
  no header. Isso o torna alcançável por XSS, ao contrário do cookie de sessão atual,
  que é `HttpOnly`.
- **Fraco contra subdomínio comprometido**, que pode escrever cookie no domínio-pai —
  cenário em que a allowlist de `Origin` da camada 2 continuaria bloqueando.

**E custa:** `apps/web/src/api.ts` (450 linhas) passaria a buscar e anexar token em
toda mutação, e o fluxo Bearer precisaria de isenção explícita — reintroduzindo,
dentro da configuração do plugin, exatamente a regra que o hook já implementa em 40
linhas comentadas.

**A preocupação legítima por trás da proposta** — código de segurança manual sem
teste — é real e **foi mantida no plano**: é o item **P1-3**. Testar o hook custa uma
fração da migração e ataca o risco que de fato existe. Se um dia a migração voltar à
mesa, o P1-3 é o que a torna mensurável.

### 4.2 Migrar `cacheDoToddle` para Redis — **NEGADO**, vira documentação

Proposto como P3 no esqueleto ("cache Redis para health check"). O comentário em
`app.ts:91-98` argumenta que o check é vivacidade **do processo**, e que um cache
compartilhado faria uma instância responder pela saúde de outra. O argumento está
certo. Além disso, `docker-compose.coolify.yml` fixa `replicas: 1` para o worker por
outra razão (o limiter do BullMQ é por worker). Vira **P3-1: documentar**.

### 4.3 "Padronizar design tokens" no frontend — **NEGADO**

`apps/web/src/estilos.ts` já tem paleta proprietária da EAV, cores semânticas
(`ruim`/`bom`/`atencao`), helper `comAlfa` para derivar fundos em vez de hexes novos,
e uma escolha consciente de contraste (ocre `#A67206` no lugar do amarelo da marca,
porque amarelo puro sobre branco não alcança AA). Mexer nisso seria trocar algo
correto por algo diferente. **O que entra no P1-8 é o que falta**, não o que existe.

### 4.5 Fazer o `/health` devolver 503 — **NEGADO**, virou rota separada

Proposto no esqueleto do P0-3 ("`/health` 503 quando dependência fora") e
decidido pelo usuário depois de eu levantar a consequência.

`/health` é o alvo do healthcheck do Coolify
(`docker-compose.coolify.yml:183`), que **reinicia o container** quando ele
falha. Fazer o `/health` cair junto com o Postgres criaria um crashloop que não
conserta nada:

1. reiniciar o processo não levanta banco de dados caído;
2. a cópia de base do RM acontece periodicamente neste ambiente, e nela as
   dependências ficam fora por minutos — seria crashloop autoinfligido, e
   programado;
3. quando o banco volta, N containers reiniciando em laço batem nele todos ao
   mesmo tempo.

**O que foi feito no lugar:** `/health` permanece liveness (sempre 200, "o
processo está vivo"), e `/health/ready` nasce como readiness (503, "ele
consegue trabalhar agora"). O Coolify continua apontando para `/health`; um
monitor externo aponta para `/health/ready`.

**Custo assumido, e ele é real:** o item deixa de entregar "o container reinicia
sozinho", que era a detecção escrita na matriz original. A detecção migrou para
o canal de alerta do P0-2 mais o 503 para monitor externo. A linha da matriz foi
corrigida.

**Fronteira, para não virar dogma:** reinício É a resposta certa quando o
defeito é DO PROCESSO — vazamento de memória, event loop travado, deadlock
interno. Nada disso é detectado hoje, e um liveness que só responde "o HTTP
está de pé" não os pega. Escopo futuro.

### 4.4 Multi-tenant por processo — **não é defeito, apenas documentar**

O tenant vem de `TENANT_SLUG` no ambiente, igual no worker e na API; nenhuma rota
aceita tenant por parâmetro. Está documentado em `app.ts:48-51` como limitação
consciente, com o caminho de evolução declarado (o tenant sairá do vínculo do
usuário, nunca do cliente). **Não corrigir.** Entra no `docs/RUNBOOK.md` (P2-2).

---

## 5. Breaking changes

Um item com potencial de quebrar contrato:

**P1-4 (`packages/contracts`)** — adicionar schema do Fastify às rotas muda o
comportamento de payload inválido: hoje passa e é tratado (ou não) dentro do handler;
depois vira 400 automático. Isso pode quebrar `apps/web` se algum painel envia campo
a mais ou tipo divergente que hoje é ignorado em silêncio.

**Plano de migração:**
1. Introduzir os schemas em modo **observação** primeiro: validar e **logar** a
   divergência, sem rejeitar.
2. Rodar assim por um ciclo, ler o log, corrigir o front onde divergir.
3. Só então ligar a rejeição.

**Contrato com o Toddle:** nenhum item deste plano toca `toddleClient.ts` nem o
formato dos payloads enviados ao Toddle. Sem breaking change nessa fronteira.

**Contrato com o RM:** o **P0-3** muda o comportamento em uma situação específica —
Sentença sem coluna esperada passa de "chave vazia, escrita liberada" para "exceção".
Isso é a correção, não uma quebra: hoje o caminho "funciona" produzindo dano.
Ainda assim, o primeiro run após a mudança deve ser feito em **modo ensaio**
(`naoEscreveu: 'ensaio'` já existe no código) para confirmar que nenhuma Sentença
em uso hoje já está sem a coluna.

---

## 6. Risco de execução

### Primeiro: P0-6 — o item mais perigoso é um P0, e o conselho me corrigiu nisso

Eu havia nomeado o rate-limit. **Dois conselheiros apontaram o P0-6, e estão certos:**
é o único item do P0 que edita o caminho quente de leitura de **100% das faltas**, e
o defeito que ele pode introduzir é literalmente o defeito que ele previne — qualquer
mudança acidental no formato da chave (ordem dos 5 segmentos, a coerção
`Number(f.codColigada)` em `rmAttendanceSource.ts:320`) desliga o cruzamento e a
proteção contra sobrescrever lançamento humano, **em silêncio**.

Blindagem, em ordem de execução:

1. **Congelar antes de mexer** — é o P0-1, e é por isso que ele é o primeiro item do
   plano. Testes fixam a string da chave exatamente como é hoje. Merge só passa se a
   chave não mudar.
2. **Teste de identidade entre os dois lados**: garantir que `chaveNaturalDeFalta`
   continua *chamando* `chaveNaturalRm` e não reimplementando-a.
3. **Falhar no leitor, não no comparador**: a exceção nasce na montagem da linha em
   `rmAttendanceSource.ts`, antes de qualquer veredito. O run aborta inteiro, sem
   escrita parcial.
4. **Flag `STRICT_NATURAL_KEY`, default `false`**, validada no `env.ts` que já tem Zod.
5. **Primeiro deploy em modo sombra**: calcular vereditos e contadores sem escrever,
   comparar a distribuição com o run anterior, ligar a escrita só se a fração de
   "casou" bater. O código de ensaio já existe (`naoEscreveu: 'ensaio'`).
6. **`volumeGuard` ligado durante todo o rollout** (`sincronizarFrequencia.ts:341`).

### Segundo: P1-5 (rate-limit) — um problema de topologia que o conselho não podia ver

`apps/web/nginx.conf:26` faz proxy de `/api` para a API e define `X-Forwarded-For`.
Mas **o Fastify não tem `trustProxy`** — verificado, não há ocorrência em
`apps/api/src`. Logo `req.ip` dentro da API é o IP do container do nginx,
**idêntico para todos os clientes**.

Com o `keyGenerator` padrão do `@fastify/rate-limit` (por IP), **todos os operadores
da escola compartilham um único balde**. Um operador clicando numa tela de de-para
derruba o acesso de todo mundo, e derruba junto o fluxo Bearer do CI. O sintoma seria
429 aparentemente aleatório, difícil de atribuir.

**Como blindar:** trocar o `keyGenerator` para o `subject` da sessão (e o token, no
caso Bearer). É o que de fato se quer limitar — não é API pública, é um painel com
usuários identificados — e não depende de acertar a cadeia de proxy. Habilitar
`trustProxy` restrito à rede do Docker é a alternativa, inferior.

### Terceiro: P1-10 (quebrar os arquivos grandes)

Move código do caminho de escrita sem adicionar garantia nenhuma. Dois conselheiros
destacaram `studentSync.processor.ts` (474 linhas) como o pedaço mais propenso a
quebrar encadeamento e contexto de escrita. Por isso está por último e depende de
P0-1, P0-6, P1-3 e P1-8.

## 7. Conselho — validação do plano

Consulta feita com **descobertas verificadas (arquivo e linha)**, não com inventário
cru — correção de método vinda do erro da FASE 1, onde o conselho raciocinou a partir
da ausência de testes e concluiu errado.

### Quem respondeu

| conselheiro | resultado | motivo |
|---|---|---|
| `claude` | respondeu (5.291 car.) | CLI, alias `opus` |
| `chatgpt` | respondeu (1.161 car.) | CLI, default do codex |
| `nemotron` | respondeu (2.829 car.) | API da NVIDIA — **voltou**, tinha falhado por timeout na FASE 1 |
| `gemini` | **falhou de novo** | `503 high demand` no CLI e `GEMINI_API_KEY` ausente em ambiente, Keychain e `.env` |

**Conselho parcial: 3 de 4.** Melhor que a FASE 1 (2 de 4). O assento `gemini` está
quebrado de forma consistente e só volta com uma chave configurada — vale registrar
como pendência de ferramenta, não deste projeto.

### Convergência de três vias — incorporado

**1. ESLint sai do P0.** Os três concordaram, e pelo mesmo motivo que a sua própria
regra dita: não há detecção em produção. *"É portão, não guarda."* Confirma a
conclusão que eu havia tirado independentemente. → **P1-1**.

**2. `contracts` não sobe para P0.** Os três concordaram. O argumento mais afiado:
*"o caminho de escrita acadêmica não entra por schema de rota; entra por
fila/worker."* → mantido em **P1-4**.

**3. Falta um canário de colunas da Sentença.** Os três nomearam o **mesmo** buraco,
independentemente, e é um item que eu não tinha. O argumento: o fail-high avisa
**tarde**, só depois que um run começou a processar; e não cobre o drift introduzido
pelo próprio restauro automático, que pode regredir a Sentença sem erro nenhum.
→ **item novo P0-4**.

### Contribuições individuais incorporadas

- **`claude`** — a escada de blindagem do P0-6 (congelar → identidade → falhar no
  leitor → sombra → volumeGuard), que é melhor do que a minha. E: *"rodar a suíte
  `.itest.ts` no CI é cobertura já escrita e já paga que ninguém executa, custo
  próximo de zero comparado ao ESLint"* → **item novo P1-6**. Também a observação
  de que P1-9 vira em boa parte subproduto de P1-4, refletida na ordem.
- **`nemotron`** — a flag `STRICT_NATURAL_KEY` com default `false` (item 4 da
  blindagem) e o teste de caos injetando XML sem `ID_TURMADISC`.
- **`chatgpt`** — o alerta de P0-2 tem de ser por *backlog sem avanço do
  último-job-processado*, não só por conexão, e o heartbeat precisa refletir esse
  estado.
- **`claude`**, requisito de aceite do P0-2 que eu não tinha escrito: o avaliador
  precisa ser **fora do processo**, senão *"o launchd mata os dois juntos e você
  reconstruiu o incidente de 13 dias com mais código"*. O desenho de `heartbeat.ts`
  já é externo — o requisito agora está explícito na matriz.

### Onde o conselho errou, e por quê

**Ordenação.** Os três disseram que a chave natural deve vir antes do sinal de
worker. Responderam **sem o fato de que o canal de alerta está inteiramente
desligado** — eu descobri o `ALERTA_WEBHOOK_URL` ausente depois de enviar o prompt.
Um deles chega a afirmar que *"o webhook do `deadLetter.ts` já funciona"*, o que é
falso hoje: `alerta.ts:56` devolve `false` antes de tentar. A resolução está na
seção 3: separar o **teste** (P0-1, sem risco, vem primeiro, como eles querem) da
**mudança** (P0-6, que precisa do canal).

**`SENT_UNKNOWN` (herdado da FASE 1).** Verificado: já está correto
(`wsDataServerClient.ts:474-481` devolve terceiro estado, não lança; chamadores
roteiam para `desconhecidas`). Rebaixado a teste de caracterização, **P2-4**.

### O que nenhum conselheiro podia ver

Nenhum teve acesso ao código. Dois achados do plano vieram só da verificação direta:

- **O canal de alerta está desligado** — 6 variáveis ausentes do `.env`, e
  `alerta.ts:56` / `heartbeat.ts:47` tratam ausência como desligamento silencioso.
  É a causa comum do incidente dos 62 jobs e do launchd de 13 dias.
- **Ausência de `trustProxy`** atrás do nginx, que transformaria o rate-limit do
  P1-5 num balde único para a escola inteira (seção 6).
