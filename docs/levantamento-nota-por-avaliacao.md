# Levantamento — a nota do Toddle tem de virar NOTA DE AVALIAÇÃO no RM

**Aberto em 09/09/2026**, depois de o writer de nota de etapa falhar em produção
de um jeito silencioso. Tudo abaixo foi **medido**, não suposto. O que não foi
medido está dito como pergunta.

---

## 1. Por que o destino anterior não serve

O `SaveRecord` do **`EduNotaEtapaData`** aceita o dataset, cria a linha e
**descarta o `NOTAFALTA`**: responde `ok=true`, sem erro nem aviso, e a releitura
devolve `0.0000`. Seis formatos testados (inteiro, ponto, vírgula, quatro
decimais, com `AULASDADAS`, com `IDGRUPO`) — todos iguais.

A causa está em `SETAPAS`: **`CODFORMULANOTA=01_ETAPA`**. A nota da etapa é
**calculada**, e a fórmula é dona do campo.

### A prova, em duas turmas com configuração de etapa IDÊNTICA

| | `IDTURMADISC 1541` | `IDTURMADISC 1250` |
|---|---|---|
| provas cadastradas (`SProvas`) | **2** — "Avaliação Somativa", "Simulado" | **0** |
| notas de avaliação (`SNotas`) | **32**, todas `7.0000` | **0** |
| nota da etapa (`SNOTAETAPA`) | **6.5000** | **0.0000** em todas |

A etapa da 1541 vale 6,5 porque a fórmula calculou 6,5 a partir das 32 notas de
avaliação. A da 1250 vale zero porque não há de onde calcular. **Escrever direto
na etapa é gritar para um campo que não escuta.**

---

## 2. O destino certo, e ele existe nesta instalação

Varri 26 nomes de DataServer por `GetSchema`. Os que interessam:

| DataServer | dataset | tabela | chave natural |
|---|---|---|---|
| **`EduProvasData`** | `EduProvas` | `SProvas` | `CODCOLIGADA, IDTURMADISC, CODETAPA, TIPOETAPA, CODPROVA` |
| **`EduNotasData`** | `EduNotas` | `SNotas` | `CODCOLIGADA, CODPROVA, CODETAPA, TIPOETAPA, IDTURMADISC, RA` |

Os dois seguem a mesma convenção do `EduNotaEtapa`: **sem namespace** e com
`EnforceConstraints="False"` — a deduplicação continua sendo nossa.

**NÃO existem** nesta instalação: `EduProvaData` (singular), `EduAvaliacaoData`,
`EduNotaProvaData`, `SProvaData`, `SNotaAvaliacaoData`, `EduDigitacaoNotasData`,
`EduLancamentoNotaData`, `EduNotaData`, `EduBoletimData`, `EduFormulaData`.

> `EduNotaAvaliacaoData` **existe** mas o `GetSchema` falha com "Ocorreu um erro
> ao efetuar a leitura das definições da tabela". É pergunta para a TOTVS — pode
> ser o DataServer certo com defeito de metadado.

O fluxo correto, portanto:

```
professor lança no Toddle  ->  SNotas (por CODPROVA)  ->  fórmula 01_ETAPA  ->  SNOTAETAPA
```

---

## 3. O lado do Toddle — medido em 09/09/2026

Se o destino é nota **por avaliação**, a origem deixa de ser `GET /term-grades`
(nota fechada de etapa) e passa a ser o par:

| Toddle | RM | funciona? |
|---|---|---|
| `GET /public/v2/assignments` | `SProvas` | sim — 223 no ano corrente |
| `GET /public/v2/student-assignments` | `SNotas` | sim — 2.085 resultados |

Campos que o assignment traz: `id`, `title`, `state`, `assessmentType`,
`subAssessmentType`, `teacherCourseId`, `classId`, `className`, `categoryId`,
`createdBy`, `publishedAt`, `dueDate`. O resultado por aluno traz `assignmentId`,
`studentId`, `evaluatedAt`, `evaluationSharedAt`, **`academicTermId`** (o
grading period, que dá o `CODETAPA`) e `assessmentToolData`.

### Existe valor numérico — e a escala é POR AVALIAÇÃO

`assessmentToolData` vem em quatro formas, medidas nos 2.085 resultados:

| forma | quantos |
|---|---|
| `(vazio)` — criado, não avaliado | **1.484** |
| `score` | 251 |
| `score+rubric` | 190 |
| `rubric` só | 160 |

**441 têm score numérico**, no formato `{ "value": "62", "maxScore": "66" }`. E os
`maxScore` são muitos — 80, 50, 100, 30, 20, 66, 77, 60, 70, 87, 10, 15…

Isso é bom: **`maxScore` casa com `SProvas.VALOR`** (o campo é `VALOR`, não
`NOTAMAXIMA`), então a conversão para a escala do RM é por avaliação, com o
denominador vindo do próprio dado — não uma regra global inventada.

Os 160 `rubric`-só continuam sem número, e reencontram o impasse de letra→número
agora por avaliação.

### Duas armadilhas de API, medidas

- **Nenhum dos dois endpoints tem `modifiedSince`.** Igual ao `/term-grades`. Sync
  incremental por filtro é impossível: cada passada lê tudo, e é o guarda de
  decisão que a torna barata.
- **`classIds` e `teacherCourseIds` vão em CSV**, não como array JSON — ao
  contrário de `sourceIds` e `courseIds` em outros endpoints, que exigem JSON. A
  mesma API usa as duas convenções.

---

## 3b. ⛔ O VOLUME PARA A EAV É ZERO

O funil, calculado sobre os 441 resultados numéricos:

```
  com score numérico            441
  - turma sem de-para COURSE    441
  - aluno sem de-para STUDENT     0
  - term sem de-para GRADING      0
  = PROJETÁVEIS                   0
```

**Todos os 441 são dado de demonstração.** Dos 223 assignments, **222 pertencem a
turmas que não são da EAV** — são 49 turmas de seed do Toddle: "Y10 Math B",
"Y8 English A", "Year 3 Jupiter", "Year 10 - Accounting A"…

Das **186 turmas-disciplina mapeadas, exatamente 1** tem algum assignment:

> `"Teste integracao RM - Formacao do relevo brasileiro"`
> Geografia — 11th grade A, criado em 25/08/2026, tipo `learning_engagement/le`
> **26 alunos, ZERO avaliados**, `assessmentToolData: {}` em todos

### O que isso significa

O bloqueio deixou de ser técnico. O caminho está provado nas duas pontas —
`EduNotasData` grava e persiste, `student-assignments` lê e traz número — e **não
há nada para carregar**: os professores não estão avaliando no Toddle.

Construir o pipeline agora seria construir para zero dado. E as decisões de
desenho que faltam (quais tipos de assignment viram nota, como converter escala,
o que fazer com rubrica) **não têm resposta sem observar o professor usando**. São
perguntas sobre comportamento, e a amostra é vazia.

**Recomendação:** antes de mais código, uma turma-piloto lançando nota de verdade
no Toddle por algumas semanas. Com dado real na mão, o de-para se escreve sozinho
e as quatro perguntas da escola ganham resposta empírica em vez de opinião.

---

## 4. As perguntas em aberto, com dono

| # | pergunta | quem responde |
|---|---|---|
| 1 | **Quem cria as provas no RM?** Se o assignment do Toddle é a origem, o middleware teria de criar `SProvas` — isso é escrever ESTRUTURA acadêmica, não só nota. A alternativa é a escola pré-cadastrar e a gente só mapear. | escola + coordenação |
| 2 | **Quais tipos de assignment viram nota?** Provavelmente só `assessment/*` (64 dos 223). `learning_engagement` e `ai_tutor` viram nota no boletim? | coordenação |
| 3 | **Conversão de escala.** O Toddle dá `62/66`; o RM guarda 0–7. Regra de três, ou tabela? É decisão pedagógica. | escola |
| 4 | **Assignment só com `rubric`** não tem número. Mesmo impasse da escala alfabética, agora por avaliação. | escola |
| 5 | **`EduNotaAvaliacaoData` existe e o `GetSchema` falha.** É o DataServer certo com metadado quebrado? | TOTVS |
| 6 | **Escrever `SNotas` dispara o recálculo da etapa?** Ou o RM só recalcula quando alguém abre a tela / roda um processo? Isto decide se a integração entrega boletim ou só dado bruto. | **teste no sandbox** |
| 7 | `SProvas.NOTAMAXIMA` e `PESO` vieram vazios na leitura da 1541. São obrigatórios na escrita? Como a fórmula `01_ETAPA` pondera? | TOTVS + coordenação |

---

## 5. O TESTE FOI FEITO — 09/09/2026

Executado na `IDTURMADISC 1250` (zero provas, zero notas, etapa toda `0.0000`,
nenhum trabalho humano em risco). Três passos, com releitura em cada um.

| passo | resultado |
|---|---|
| `SaveRecord EduProvasData` — criar avaliação (`CODPROVA=1`, `VALOR=7`) | **`ok=true`, e persistiu**: releitura devolve `VALOR=7.0000` |
| `SaveRecord EduNotasData` — lançar `NOTA=7` para o RA 202600199 | **`ok=true`, e persistiu**: releitura devolve `NOTA=7.0000` |
| reler `SNOTAETAPA` da chave `1\|1\|N\|1250\|202600199` | **`0.0000`** — não recalculou |

Depois tentei forçar o recálculo por três caminhos, todos `ok=true` e todos sem
efeito:

- tocar o `SNotaEtapa` só com a chave (sem `NOTAFALTA`) → `0.0000`
- tocar mandando `NOTAFALTA=7`, **agora com avaliação de valor 7 e nota 7
  existindo** → `0.0000`
- reler 15 segundos depois, caso o recálculo fosse assíncrono → `0.0000`

### As três conclusões

**1. A nota TEM caminho de escrita, e ele funciona.** `EduNotasData` grava e
**o valor persiste** — exatamente o que o `EduNotaEtapaData` não faz. A hipótese
de que o `EduNotaEtapaData` "recalculava em vez de descartar" está **descartada**:
com avaliação e nota presentes, ele continua devolvendo zero.

**2. Fechar a etapa NÃO é nosso.** O recálculo do `SNOTAETAPA` acontece em algum
processo do RM que nenhum destes DataServers dispara — provavelmente a tela de
digitação ou uma rotina de "cálculo da nota da etapa". Que ele EXISTE está
provado pela 1541: 32 notas de `7.0000` e etapa `6.5000`, ou seja, alguma fórmula
rodou lá e ponderou.

**3. E isso talvez seja o desenho correto.** A integração entrega **a nota que o
professor lançou**, no nível em que ele a lançou (avaliação). Fechar trimestre é
ato pedagógico, com data-limite de digitação (`DTLIMITEDIGITACAO=2026-06-19` na
etapa 1) e conferência — não deveria acontecer por cron de meia em meia hora.

### O que isso muda nas perguntas em aberto

A pergunta 6 está **respondida**. Nasce uma no lugar:

| # | pergunta | quem responde |
|---|---|---|
| 8 | **Como a escola fecha a etapa hoje?** Alguém abre a tela e salva, ou existe uma rotina? Se for manual, a integração entrega a nota da avaliação e a coordenação fecha — e isso precisa estar acordado, não suposto. | escola + TOTVS |

## 6. O que está pronto e continua servindo

Na branch `feat/nota-agendada`, tudo isto independe do destino e é reaproveitável:

- leitura e achatamento do Toddle, projeção com 10 recusas, montagem de XML
- os quatro guardas (projeção, decisão, pendência, teto+gate de aprovação)
- o job agendado, o poll com interruptor de duas vias e o preflight
- 120 testes

O que muda quando a pergunta 6 for respondida: o **montador de XML** (dois
datasets em vez de um), o **de-para de avaliação** (novo tipo na `id_mapping`) e
o **leitor do Toddle** (`student-assignments` em vez de `term-grades`).

> ⚠️ **Rastro deixado por este levantamento no sandbox** (a medição do lado
> Toddle foi só leitura e não acrescentou nada a esta lista)
>
> - `SNOTAETAPA` chave `1|1|N|1250|202600199`: linha criada por mim, valor
>   `0.0000`. Não existia antes. Indistinguível das outras 21 daquela turma, que
>   também são zero, e não há `DELETE` pelo DataServer.
> - Toddle: duas notas de teste no T1 — `6` para o RA 202600053 (Geografia) e `5`
>   para o RA 202600199 (Orientação de Estudos). O `POST` é upsert e a API não
>   expõe remoção.
> - **`SProvas` da `IDTURMADISC 1250`: uma avaliação criada por mim**, `CODPROVA=1`,
>   `VALOR=7.0000`, descrição `"TESTE INTEGRACAO - avaliacao criada para medir
>   recalculo"`. Está nomeada para ser encontrada.
> - **`SNotas` dessa avaliação: `NOTA=7.0000` para o RA 202600199.** Não achei
>   caminho de `DELETE` por DataServer — se precisar sair, é pela tela do RM.
