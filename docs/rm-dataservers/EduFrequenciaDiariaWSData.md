# `EduFrequenciaDiariaWSData` — gravação de frequência no RM via SOAP

O DataServer que executa a **regra de negócio de frequência** do RM Educacional.
É por ele que a via Toddle → TOTVS lança presença/ausência.

Levantado em **04/08/2026** contra o RM de **desenvolvimento** da EAV
(`wsDataServer`, porta 1951, mesmas credenciais do `wsConsultaSQL`), escopo
coligada 1 / filial 2 (aeroporto).

O XSD cru, como o RM devolveu, está em `EduFrequenciaDiariaWSData.xsd`.

> **Convenção deste documento:** o que foi **medido** contra o RM está afirmado
> direto. O que veio da documentação da TOTVS e **não** foi verificado está
> marcado como tal. Não há terceira categoria — se não está dito, foi medido.

---

## 1. Use este nome, não o outro

| DataServer | serve para |
|---|---|
| `EduFrequenciaDiariaWSData` | **este** — web service |
| `EduFrequenciaDiariaData` | telas do produto; a TOTVS documenta que não deve ser usado por WS |

Os dois existem nesta instalação. Chamar o segundo por engano é erro silencioso:
ele responde. O nome certo veio de um alerta do conselho técnico, e foi conferido
por `GetSchema`.

## 2. O dataset

Raiz `EduFrequenciaDiaria`, `targetNamespace`
`http://tempuri.org/EduFrequenciaDiaria.xsd`.

A estrutura é `xs:choice maxOccurs="unbounded"`: as quatro tabelas aparecem em
**qualquer ordem e qualquer quantidade**. Não é uma sequência fixa.

São **quatro** tabelas, não três como supunhamos: `SFREQUENCIA`, `PARAMS`,
`AlunosFreq` e `PlanoAulaFreq`.

### `SFREQUENCIA` — o lançamento

| campo | tipo | obrigatório |
|---|---|---|
| `CODCOLIGADA` | `xs:short` (default `1`) | sim |
| `IDHORARIOTURMA` | `xs:int` | sim |
| `IDTURMADISC` | `xs:int` | sim |
| `RA` | string ≤ 20 | sim |
| `DATA` | `xs:dateTime` | sim |
| `PRESENCA` | string, 1 caractere | sim |
| `JUSTIFICADA` | string, 1 caractere (caption *"Abona"*) | não |
| `IDJUSTIFICATIVAFALTA` | `xs:int` | não |

### `PARAMS`

| campo | tipo | obrigatório |
|---|---|---|
| `CODCOLIGADA` | `xs:short` | sim |
| `IDTURMADISC` | `xs:int` | sim |
| `CODETAPA` | **`xs:string`** | sim |
| `AULASDADAS` | `xs:int` | **não** — ver §4 |
| `CODSUBTURMA` | `xs:string` | não |

Não há `TIPOETAPA` no `PARAMS`. Sendo o DataServer específico de frequência, o
tipo `'F'` (falta) é implícito — ver §5.

### `AlunosFreq` — o roster considerado na operação

`CODCOLIGADA`, `RA`, `IDTURMADISC` obrigatórios; `IDTURMADISCORIGEM` opcional.

### `PlanoAulaFreq`

Os cinco campos são opcionais: `CODCOLIGADA`, `IDTURMADISC`, `CODETAPA`
(`xs:int` aqui, `xs:string` no `PARAMS` — inconsistência do próprio schema),
`AULA`, `FREQUENCIADISPWEB`.

## 3. A chave primária vem declarada no schema

```xml
<xs:unique name="Constraint1" msdata:PrimaryKey="true">
  <xs:selector xpath=".//mstns:SFREQUENCIA"/>
  CODCOLIGADA + IDHORARIOTURMA + IDTURMADISC + RA + DATA
</xs:unique>
```

Isso é o RM afirmando, não o PDF: a existência do lançamento é verificada por
**chave natural composta**. A idempotência da volta não depende de nenhuma
convenção nossa — reenviar o mesmo registro converge para o mesmo estado.

**Mas o dataset vem com `msdata:EnforceConstraints="False"`.** Ele **não** vai
rejeitar duas linhas com a mesma PK. Deduplicar é responsabilidade do
middleware, e duas origens Toddle que colidam na mesma PK do RM devem ir para
revisão — nunca "vence o último".

## 4. `AULASDADAS` é opcional, e isso importa muito

`<xs:element name="AULASDADAS" type="xs:int" minOccurs="0"/>`

`AULASDADAS` é o **denominador da frequência mínima**, que nas etapas de falta
desta escola é **75%**. Escrever valor errado ali não erra um registro de
presença: altera o cálculo de reprovação por falta.

A gramática permite **omitir o campo**, e é o que devemos fazer. O middleware
não tem por que administrar o número de aulas dadas.

> **Não verificado:** opcional no XSD não é o mesmo que opcional na regra de
> negócio — a aplicação pode exigir o campo em tempo de execução. É a primeira
> coisa a testar no primeiro `SaveRecord`.

Preenchimento atual no RM, nas 555 etapas graváveis (medido):

| etapa | `AULASDADAS` preenchido |
|---|---|
| 1 (1º trimestre) | 182/185 |
| 2 (2º trimestre) | 185/185 |
| 3 (3º trimestre) | **0/185** — o trimestre ainda não começou |

`CODSUBTURMA` também pode ser omitido: **não existe nenhuma subturma na
coligada 1**. O `ReadView` em `EduSubTurmaData` aceitou o filtro
`SSubTurma.CODCOLIGADA=1` (sem fault, logo a coluna é válida) e devolveu zero
linhas.

## 5. Os insumos, e como cada um se resolve

Todos os cinco campos da PK são deriváveis de forma determinística a partir do
que a API do Toddle devolve em `GET /public/v2/attendance`.

| campo do RM | origem | como |
|---|---|---|
| `CODCOLIGADA` | configuração | `RM_CODCOLIGADA` |
| `IDTURMADISC` | `courseId` do Toddle | `id_mapping` `COURSE`, 185 ativos, modelo 1:1 com `STURMADISC` |
| `RA` | `studentId` do Toddle | `id_mapping` `STUDENT`, 253 ativos |
| `DATA` | `date` do Toddle | ver a armadilha de fuso em §6 |
| `IDHORARIOTURMA` | `periodId` + `date` | ver §5.1 — e §5.3, que é onde isso hoje trava |
| `CODETAPA` (`PARAMS`) | `date` | ver §5.2 |

### 5.1 `IDHORARIOTURMA` — resolvido, e único

Medido em `EduHorarioTurmaData` (elemento `SHorarioTurma`): 612 horários na
filial 2, dos quais **518 pertencem às 185 turmas-disciplina em escopo**, todas
no `IDPERLET 15`. Nenhuma turma-disciplina em escopo está sem horário.

O volume é pequeno: **7 faixas de horário distintas** e 35 combinações
dia+faixa, de segunda a sexta (`DIASEMANA` 2 a 6).

O RM já codifica a faixa no `CODHOR`, no formato `<dia><022><faixa>`, verificado
1:1:

| sufixo do `CODHOR` | faixa |
|---|---|
| `001` | 08:00–08:20 |
| `002` | 08:20–09:20 |
| `003` | 09:20–10:20 |
| `004` | 10:40–11:40 |
| `005` | 11:40–12:40 |
| `006` | 13:50–14:50 |
| `007` | 14:50–15:50 |

**A resolução é determinística:** `(IDTURMADISC, DIASEMANA, faixa)` produziu
**518 chaves para 518 horários** — zero colisão. Logo
`courseId` + dia da semana (derivado da `date`) + faixa (do `periodId`) →
exatamente um `IDHORARIOTURMA`. Sem fallback por data, sem "primeira aula do
dia".

Pendências pequenas: 8 horários sem `DATAINICIAL`/`DATAFINAL`, e 32 com janela
parcial (11 terminam em 24/04 e 11 começam em 27/04 — troca de grade no meio do
ano). Nenhuma cria ambiguidade, porque a chave já é única sem a data.

> A faixa `08:00–08:20`, de 20 minutos, aparece em 60 horários. Pelo formato não
> parece aula regular — acolhida ou *homeroom*. **Não confirmado** com a
> coordenação; se for onde a frequência oficial é lançada, é a mais importante
> de todas.

### 5.2 `CODETAPA` — resolvido por data

Medido em `EduEtapasData` (elemento `SEtapas`): 2.035 etapas, exatamente **11
por turma-disciplina**, nenhuma turma sem etapa. A chave é
`(CODETAPA, TIPOETAPA)` — não `CODETAPA` sozinho. `TIPOETAPA` separa `F` de
falta (4 por turma) e `N` de nota (7 por turma). **Frequência usa `F`.**

| `CODETAPA` | descrição | janela | `PERMITEDIGITACAO` |
|---|---|---|---|
| 1 | Faltas - Primeiro Trimestre | 03/02 → 15/05 | `S` |
| 2 | Faltas - Segundo Trimestre | 18/05 → 04/09 | `S` |
| 3 | Faltas - Terceiro Trimestre | 09/09 → 11/12 | `S` |
| 4 | Total Faltas | 04/02 → 11/12 | `N` (`ETAPAFINAL=S`) |

A etapa 4 é calculada e **não recebe lançamento** — é ela que produz a maior
parte das sobreposições de janela se o filtro esquecer `PERMITEDIGITACAO`.

**O filtro correto é `TIPOETAPA='F' AND PERMITEDIGITACAO='S'`**, que dá 555
etapas (185 × 3) com janelas disjuntas. Nesse recorte, `date → CODETAPA` é
determinístico.

`FREQMIN` = 75,00 nas etapas de falta. `ETAPAENCERRADA='N'` em todas as 2.035 —
coerente com ser o ambiente de desenvolvimento; **em produção isso será
diferente e escrever em etapa encerrada é alterar registro acadêmico fechado.**

### 5.3 O lado do Toddle NÃO fecha ainda — medido em 04/08/2026 no shadow mode

Resolver o `IDHORARIOTURMA` precisa da HORA da aula. Três medições, na ordem em
que apareceram:

1. **O `startTime` do registro de frequência vem NULO** — 800 de 800 numa
   amostra, mesmo em registros que têm `periodId`. Não dá para depender dele.
2. **A hora existe em `GET /public/v2/bell-schedule`**, no `periodSet`, como
   `{ periodId, startTime, endTime }`. Duas armadilhas: a rota é **singular**
   (`/bell-schedules` devolve "Route Not Found" com HTTP 400, o que parece
   inexistência) e `academicYearIds` é obrigatório, como ARRAY SERIALIZADO EM
   JSON — a mesma armadilha do `sourceIds`.
3. **`periodId` sozinho não determina a hora.** Dos 57 períodos com hora, **9
   aparecem em bell schedules diferentes com horas diferentes** (um deles em 4
   faixas: 08:00–08:45, 08:15–08:45, 08:15–09:00, 09:15–10:00). O registro de
   frequência não diz qual grade vale.

E o bloqueio de fato:

| | faixas |
|---|---|
| RM (campus 2) | 7 |
| Toddle (11 bell schedules) | 44 |
| **em comum** | **0** |

As 11 grades do Toddle são de demonstração (PYP, DP, Early Years, Summer,
Winter, MYP, ENC, UBD ×2, IPC), em malha de 15/30/45 minutos. A grade real do
campus 2 nunca foi cadastrada lá.

**Consequência:** enquanto isso não mudar, nenhum lançamento do Toddle tem como
apontar para uma aula do RM — e é correto que o shadow mode devolva zero
projetáveis. Não é bug.

**RESOLVIDO em 04/08/2026** por `npm run seed:periodos -- --executar`: criamos os
7 períodos e a grade `EAV Campus 2 - Fund II e Medio (RM)` no currículo
`404045620567895976` (`UBD` / "Independent Programme" — o mesmo que as 185 turmas
declaram) e no ano acadêmico `404045942505890665` (`isCurrent`).

Depois disso: **7 faixas em comum**, e os 7 novos períodos não são ambíguos.
Verificado com um registro no formato real (`startTime: null` + `periodId`): a
projeção resolve `IDTURMADISC`, `IDHORARIOTURMA` e `CODETAPA` sem nenhum chute.

Uma ressalva que não dá para contornar: **`POST /public/v2/period` não aceita
`sourceId`** — o Toddle gera o dele (`TDP-<id>`). Então não existe idempotência
por chave nossa, e o de-para `faixa → periodId` vive só no `id_mapping` (tipo
`PERIOD`, migração 007). Perder essas 7 linhas é perder a identificação dos
períodos que criamos; uma segunda execução criaria duplicados indistinguíveis
pela API. `DELETE /period` existe, então o desfazer é real —
`npm run seed:periodos -- --remover --executar`.

### 5.4 Metade da chamada é de homeroom

No diagnóstico de 13–17/07/2026, dos 1.302 registros lidos, **642 (49%) vêm com
`courseId` nulo** — chamada de homeroom (`masterAttendance`). Sem curso não há
`IDTURMADISC`, e a projeção recusa.

Isso não é defeito do dado: é um modelo diferente. Se a escola lança a
frequência oficial no homeroom e não por disciplina, a via de volta precisa de
política para dizer a qual turma-disciplina do RM aquilo corresponde — e isso é
decisão pedagógica, não técnica.

### 5.5 A grade do Toddle tem TRÊS níveis, e o terceiro está bloqueado

Medido em 04/08/2026, tentando lançar uma frequência de teste.

```
período         →  o que é uma "aula 2"                7 de 7    criados
bell schedule   →  a que hora a "aula 2" começa        1 de 1    criada
timetable slot  →  qual turma tem aula 2 na segunda    0 de 518  BLOQUEADO
routine         →  qual grade de horário vale em qual dia       VAZIA
```

> **ATUALIZAÇÃO 06/08/2026 — isto deixou de ser bloqueio.** Pela decisão D1
> (`docs/DECISOES.md`), os professores lançam frequência **pela interface** do
> Toddle. O `POST` abaixo só servia para eu fabricar dado de teste; a chamada real
> nasce na tela e é lida pelo `GET /attendance`, que funciona. O parágrafo fica
> como registro do que foi medido, não como impedimento.

O `POST /public/v2/attendance` recusa com `"Attendance Record is not valid"`
enquanto não houver timetable slot. **Isso não é peculiaridade da nossa
integração: sem os slots, professor nenhum consegue lançar chamada por
disciplina no Toddle.**

E o `POST /public/v2/timetable-slots` **devolve `{ isSuccess: true }` sem criar
nada**. Verificado: criei um slot, o POST confirmou, e o `GET` não o devolve em
nenhuma janela. A consulta está certa — as variantes erradas devolvem 400
nomeando o problema (`academicYearId is invalid`, `curriculumId is required`,
`The difference between start date and end date should not exceed one month`), e
a nossa não devolve erro nenhum, só `totalCount=0`.

**A causa está na routine.** A única routine do currículo (`ENC`,
`404046160261573423`, modo `OPERATIONAL_DAYS`, vigência 30/01 → 20/11/2026) tem:

```
bellSchedulesMapping: []     ← vazio
dayPatterns:          []
rotationDays:         []
```

`bellScheduleMap` é **obrigatório** ao criar routine, e no modo
`OPERATIONAL_DAYS` tem a forma `{ weekday, bellScheduleId }`. Esta routine foi
criada sem nenhum, então não existe estrutura de dia onde um slot se fixe.

**Por que não corrigi:** a routine `ENC` cobre as **15 séries** do currículo, de
Pre-K a Grade 12. As 185 turma-disciplina em escopo são só **MS (114) e HS (71)**
— Grade 6 a 12. Mapear a grade do campus 2 nessa routine aplicaria o horário do
campus 2 a Pre-K, K1, K2 e Year 1–5, que estão **fora de escopo por decisão da
escola**. Alterar configuração compartilhada de outros segmentos não é decisão
de implementação.

Os dois caminhos, ambos de decisão da escola:

1. **Routine nova**, restrita às séries de Grade 6 a 12, com `bellScheduleMap`
   apontando para a grade `EAV Campus 2 - Fund II e Medio (RM)`. Aditivo e
   corretamente escopado. **Não verificado** se duas routines no mesmo currículo
   e vigência conflitam.
2. **Configurar pelo portal**, por quem administra o Toddle da escola.

Enquanto isso não existir, `npm run seed:timetable` para na sonda: ele cria UM
slot, lê de volta, e aborta se o GET não o devolver — justamente para não criar
518 registros sem `DELETE` numa estrutura que não os materializa.

### 5.6 Não existe carga histórica

`POST /attendance` para 02/03/2026 recusou com
`"The student is not enrolled on the given date"`. As matrículas no Toddle foram
criadas em agosto de 2026, então qualquer data anterior é recusada.

Consequência: a frequência de fevereiro a julho de 2026 não pode ser espelhada no
Toddle nem reconciliada por ele. A via de volta só vale para o que for lançado a
partir de agora.

### 5.7 O calendário virou recusa dura

`POST /timetable-slots` com `applicableTill = 2026-12-11` (vigência do horário no
RM) foi recusado:

> `Applicable till should be within academic year start and end date`

O ano acadêmico do Toddle termina em **20/11/2026**; o ano letivo do RM vai até
**11/12/2026**. Dos 518 horários, **494 precisam ser limitados**. As aulas entre
21/11 e 11/12 não podem ter grade no Toddle, logo não aceitam chamada lá. É
decisão de calendário da escola — nenhuma escolha de implementação contorna.

### 5.8 A routine: o que é possível, e o que é irreversível

Sondado em 04/08/2026 com payloads **desenhados para falhar** — `400` não altera
nada, e a routine foi conferida antes e depois de cada tentativa (intacta).

**A rota de update é `PUT /public/v2/routine/:id`.** A documentação diz `POST`, e
está errada: `POST` devolve `Route Not Found`. Também não existem
`PATCH /routine/:id`, `POST /routines/:id` nem `POST /routine/:id/update`.

**`routineMode` não pode ir no payload:** `"Routine mode cannot be updated"`.

**O update é substituição, não remendo.** `label`, `gradeIds`, `startDate`,
`endDate`, `countHolidayAsRotationDay` e `bellScheduleMap` são todos obrigatórios
— mandar só o `bellScheduleMap` não funciona.

**Os dias operacionais da organização são 1 a 5**, e isso significa que
**o Toddle usa 1 = segunda**, contra 2 = segunda no RM. Descoberto por
eliminação: só `[1,2,3,4,5]` passou a validação; `1..7`, `2..7`, `0..6` e `2..6`
foram recusados com *"must include all operational days"*. Não há endpoint que
liste esses dias — a única forma de saber é provocar o erro.

> Este off-by-one estava no `seedTimetable` já commitado: ele mandava
> `weekDay = DIASEMANA` do RM, e a grade inteira cairia um dia adiantada, 518
> vezes, sem `DELETE` para corrigir. Foi a sonda do próprio script que impediu.

**O payload que funcionaria**, confirmado por eliminação (a última sonda falhou
*só* no `bellScheduleId`, com `"Invalid bellScheduleIds"`, provando que todo o
resto foi aceito):

```
PUT /public/v2/routine/404046160261573423
{
  "label": "ENC",
  "gradeIds": [ …as 15 séries… ],
  "startDate": "2026-01-30",
  "endDate": "2026-11-20",
  "countHolidayAsRotationDay": false,
  "bellScheduleMap": [
    { "weekday": 1, "bellScheduleId": "411470826336962945" },
    …até weekday 5…
  ]
}
```

#### É IRREVERSÍVEL

`bellScheduleMap: []` é **recusado**: `"Invalid or missing Bell Schedule"`. E
`bellScheduleMap` é obrigatório **também no create**. Logo o estado atual da
`ENC` — mapeamento vazio — **não é alcançável pela API**, nem por update nem
apagando e recriando.

Consequência: mapear a grade na `ENC` é uma via de mão única. Dá para trocar por
outra grade depois, não para voltar a "nenhuma". Reverter exigiria o portal (se
ele permitir) ou o suporte do Toddle.

#### E uma routine nova não resolve

`POST /routine` com as 7 séries de Grade 6 a 12 é recusado:
`"Routine already exists for selected grades for specified validity period."`
A `ENC` já detém essas séries de 30/01 a 20/11/2026 — a nossa janela inteira.
Uma série não pode estar em duas routines com vigências sobrepostas.

Ou seja: **todo caminho passa por alterar a `ENC`**, que cobre as 15 séries do
currículo. As 185 turma-disciplina em escopo são só MS e HS. O efeito nas outras
8 séries (Pre-K a Grade 5) seria inerte no dado — elas não têm turma nem slot no
nosso sync — mas a grade apareceria para elas na interface. É decisão da escola.

### 5.9 O update da routine bate num bug do servidor — e para aqui

Executado em 05/08/2026, com a decisão de escopo tomada (Pre-K a Grade 5 não
entram, então o alcance da routine nas 8 séries de fora é aceitável).

A sequência de erros do `PUT /public/v2/routine/:id`, cada um resolvendo o
anterior:

| payload | resposta |
|---|---|
| sem `rotationDays`/`dayPatterns` | `Cannot read properties of undefined (reading 'map')` |
| **com** `rotationDays: []` e `dayPatterns: []`, `bellScheduleId` **falso** | `Invalid bellScheduleIds` — validação, payload aceito |
| idem, `bellScheduleId` **real** | `Cannot read properties of undefined (reading 'id')` |

**`rotationDays: []` e `dayPatterns: []` são obrigatórios**, ao contrário da doc,
que os declara exclusivos de `ROTATION_CYCLE`. Omiti-los estoura o backend. Está
corrigido no cliente, que os injeta.

Mas o segundo erro **não tem contorno pela API**. Com um `bellScheduleId` inválido
o payload passa a validação inteira (prova de que `label`, `gradeIds`, datas,
`countHolidayAsRotationDay` e o formato `{weekday, bellScheduleId}` estão certos);
com o `bellScheduleId` real, o servidor estoura lendo `.id` de `undefined`. Seis
formas da entrada foram tentadas — `rotationDay` em vez de `weekday`, `id` em vez
de `bellScheduleId`, objeto aninhado, `weekday` como string — e nenhuma passou;
duas devolveram **HTTP 500**. Parei aí.

**Causa provável, não confirmada:** os períodos do Toddle pertencem a um
`periodSet` — o cursor de `GET /periods` carrega `periodSetId`. `POST /period`
**não aceita esse campo**, então os 7 que criamos provavelmente não têm um, e a
routine estouraria ao tentar ler o `.id` desse conjunto. Se for isso, **não há
como corrigir pela API**: falta um campo que o endpoint de criação não expõe.

Nada foi alterado. Conferido depois de cada tentativa:

```
routine ENC     15 séries, bellSchedulesMapping 0, vigência 30/01 → 20/11  (intacta)
nossa grade     1, com 7 períodos                                          (intacta)
de-para PERIOD  7 linhas                                                    (intacto)
timetable slots 0                                                           (nenhum criado)
```

**Onde isso deixa a via de volta:** os dois primeiros níveis da grade estão
corretos e verificados; o terceiro depende de ligar a grade à routine, e essa
ligação não é alcançável pela API desta organização. O caminho que resta é o
**portal do Toddle** — quem administra abre a routine `ENC` e associa a grade
`EAV Campus 2 - Fund II e Medio (RM)` aos dias de segunda a sexta. Depois disso,
`npm run seed:timetable -- --executar --limite 3` valida com um slot e
`npm run seed:timetable -- --executar` cria os 518.

## 6. Armadilhas

### 6.1 `DATA` não tem fuso

`msdata:DateTimeMode="Unspecified"`. Enviar `2026-03-02T00:00:00`, **sem `Z` e
sem offset**.

Não é preciosismo: horas de deslocamento movem a data. `04/09` viraria `05/09`,
que cai no vão sem etapa (§7.2); ou muda o dia da semana, que é a entrada da
resolução do `IDHORARIOTURMA`. **Um erro de fuso aqui não erra o horário, erra a
aula.**

### 6.2 O RM sinaliza erro com HTTP 200

A mensagem vem **dentro** do corpo da resposta, em `SaveRecordResult`, muitas
vezes com stack trace .NET. Já enganou este projeto duas vezes — inclusive um
script de teste que reportou "o RM aceitou um dataset vazio" porque só procurava
`<faultstring>`.

**HTTP 200 só é sucesso se o corpo passar por um parser estrito de sucesso.**

### 6.3 Nomes de elemento são *case* misto

O XML de resposta usa `SPLetivo`, `SHorarioTurma`, `SEtapas`, `STurmaDisc` — não
`SPLETIVO`, `SETAPAS`. Um regex que assume maiúsculas encontra **zero linhas sem
lançar erro**, o que parece "tabela vazia". Aconteceu aqui: o levantamento de
etapas reportou 0 registros na primeira execução.

### 6.4 `ReadView` deste DataServer usa filtro posicional, não SQL

`SFREQUENCIA.CODCOLIGADA=1` devolve
`Ocorreu um erro ao efetuar a leitura da visão: Input string was not in a correct
format.` O filtro `"1233"` devolve erro **diferente** — `Index was outside the
bounds of the array` — o que prova que a string é dividida por `;` e que faltam
elementos.

A gramática exata **não foi descoberta** (6 formas tentadas). O mesmo vale para
`EduFrequenciaDiariaData`. Consequência prática abaixo, §7.4.

### 6.5 `SHorarioTurma` devolve `IDPERLET` mas não aceita filtrar por ele

`ReadView` com `SHorarioTurma.IDPERLET=21` →
`Invalid column name 'IDPERLET'`. O campo **está** em cada registro devolvido.
Filtrar por ele em memória, não na view. Filtros em geral precisam de nome
qualificado (`SHorarioTurma.CODFILIAL=2`), senão dá *Ambiguous column name*.

### 6.6 `IDPERLET` é por filial

`CODPERLET 2026` resolve para **dois** `IDPERLET`: 14 (filial 1) e 15 (filial 2).
O mesmo padrão em `2027`, `ASE2026` e `ASW2026`.

| | `IDPERLET 14` | `IDPERLET 15` |
|---|---|---|
| `CODFILIAL` | 1 (Vitória) | 2 (aeroporto) |
| `DTINICIO` | 2026-02-04 | 2025-09-01 |
| `DTFIM` | 2026-12-31 | 2026-12-31 |

Hoje é inofensivo: a Sentença deliberadamente não filtra campus e o middleware
filtra por `RM_CODFILIAL` em código. **Mas `RM_CODPERLET` global é uma restrição
de desenho para o white label** — um tenant com dois campi precisa resolver o
período letivo por campus, como já faz com a filial.

## 7. Pendências reais, que são de decisão da escola

### 7.1 Uma turma-disciplina com etapa ambígua

`IDTURMADISC 1256` = `EAVHS11IA` / Matemática (`HS0005`): a etapa 1 vai até
**10/07** em vez de 15/05, sobrepondo a etapa 2. Para essa turma, qualquer aula
entre 18/05 e 10/07 cai em duas etapas graváveis. É a **única em 185**.

Ou é erro de cadastro, ou é intencional para uma disciplina semestral. **Não
desempatar por heurística** — enquanto não houver decisão, essas datas vão para
`UNMAPPED`.

### 7.2 Dois dias de aula sem etapa que os cubra

Projetando as datas de aula do ano (dia da semana × vigência de cada horário):
**22.120 aulas**, das quais **202 caem fora de qualquer etapa gravável**, todas
em **07/09 (seg)** e **08/09 (ter)** — 101 em cada. É exatamente o vão entre a
etapa 2 (fecha 04/09) e a 3 (abre 09/09).

07/09 é a Independência. **08/09 não foi confirmado**: é provável emenda, mas o
calendário acadêmico do RM (`GCALEND`, `ECFPERLET`, `GCALENDEVENTOSACAD`) não
tem DataServer exposto — 5 nomes tentados, nenhum existe. Se 08/09 for dia
letivo, são 101 aulas sem etapa.

### 7.3 Calendário Toddle × RM

O ano letivo do Toddle termina em **20/11/2026**; as aulas no RM vão até
**11/12/2026**. São cerca de **três semanas de dezembro fora do ano letivo do
Toddle** — frequência lançada nesses dias não tem onde cair.

### 7.4 O domínio de `PRESENCA` não foi verificado

Continua não verificado depois do shadow mode: as únicas opções que aparecem no
dado real são `Present [P]` e `Absent [A]`, mas isso é o que o **Toddle** usa —
não prova o que o **RM** aceita.



`'A'` = ausência e `'P'` = presença (que remove a ausência correspondente) vêm
**da documentação da TOTVS**, não de medição — por causa de §6.4 não foi possível
ler nenhum lançamento existente, nem saber se existe algum neste RM.

Também não verificado: como as opções do Toddle que não são presença/ausência
binária (atraso, falta justificada) devem mapear para `PRESENCA` +
`JUSTIFICADA` + `IDJUSTIFICATIVAFALTA`. Reduzir tudo a `A`/`P` **perde
semântica** e precisa de política formal da escola.

## 8. Payload mínimo

Sem `AULASDADAS`, sem `CODSUBTURMA`, sem `PlanoAulaFreq`:

```xml
<EduFrequenciaDiaria xmlns="http://tempuri.org/EduFrequenciaDiaria.xsd">
  <PARAMS>
    <CODCOLIGADA>1</CODCOLIGADA>
    <IDTURMADISC>1233</IDTURMADISC>
    <CODETAPA>1</CODETAPA>
  </PARAMS>
  <AlunosFreq>
    <CODCOLIGADA>1</CODCOLIGADA>
    <RA>000000</RA>
    <IDTURMADISC>1233</IDTURMADISC>
  </AlunosFreq>
  <SFREQUENCIA>
    <CODCOLIGADA>1</CODCOLIGADA>
    <IDHORARIOTURMA>0000</IDHORARIOTURMA>
    <IDTURMADISC>1233</IDTURMADISC>
    <RA>000000</RA>
    <DATA>2026-03-02T00:00:00</DATA>
    <PRESENCA>A</PRESENCA>
  </SFREQUENCIA>
</EduFrequenciaDiaria>
```

Contexto obrigatório do `wsDataServer`:
`CODCOLIGADA=1;CODFILIAL=2;CODTIPOCURSO=1;CODSISTEMA=S`.

## 9. Antes do primeiro `SaveRecord`

1. **Shadow mode primeiro.** Ingerir a frequência do Toddle, resolver os
   mapeamentos, montar o XML e mostrar o que *seria* enviado. Zero escrita.
2. **Autorizar por interseção positiva, nunca por exclusão.** Só envia se
   `studentId`, `courseId` e `periodId` têm mapeamento ativo, e se tenant,
   campus, coligada, filial, tipo de curso e `configVersion` coincidem. Qualquer
   ausência é `UNMAPPED`/`OUT_OF_SCOPE`, não tentativa de SOAP. Existem **86.519
   registros de frequência de demonstração** no tenant do Toddle contra 253
   alunos reais — "não é demo" e "não está arquivado" **não** são autorização.
3. **Testar se `AULASDADAS` omitido é aceito** (§4).
4. **Timeout é `SENT_UNKNOWN`, não falha.** Reler o RM antes de reenviar.
5. **Não usar `Delete` nem SQL direto.** `isDeleted=true` no Toddle é evento de
   revogação no LMS; no RM é alteração de registro acadêmico legal, e passa por
   aprovação.

## 10. DataServers sondados

Confirmados nesta instalação: `EduFrequenciaDiariaWSData`,
`EduFrequenciaDiariaData`, `EduHorarioTurmaData`, `EduEtapasData`,
`EduPletivoData`, `EduSubTurmaData`, `EduTurmaDiscData`, `EduNotasData`,
`EduNotaEtapaData`, `EduMatriculaData`, `EduProfessorData`, `EduAlunoData`.

Não existem: `EduPeriodoLetivoData`, `EduPerLetData`, `EduSPLetivoData`,
`EduEtapaData`, `EduSEtapasData`,
`EduEtapasTurmaDiscData`, `EduTurmaDiscEtapaData`, `GlbCalendarioData`,
`EduCalendarioData`, `GCalendarioData`, `EduCalendPerLetData`,
`EduEventosCalendarioData`, `EduFrequenciaData`, `SFrequenciaData`,
`EduFaltaData`, `EduAulaData`, `EduDiarioClasseData`.

Um nome inexistente devolve fault com "Classe ... não encontrada"; um nome
existente com filtro ruim devolve fault de leitura. **São coisas diferentes** —
não tratar 404-equivalente como "a operação não é suportada". Este projeto já
concluiu "impossível" por dias sobre um canal que estava exposto no mesmo
host e porta.
