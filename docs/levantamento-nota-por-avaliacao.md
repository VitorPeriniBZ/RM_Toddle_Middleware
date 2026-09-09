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

## 3. O lado do Toddle muda junto

Se o destino é nota **por avaliação**, a origem deixa de ser `GET /term-grades`
(nota fechada de etapa) e passa a ser o par:

| Toddle | RM | medido |
|---|---|---|
| `GET /public/v2/assignments` | `SProvas` | **223 assignments** no sandbox |
| `GET /public/v2/student-assignments` | `SNotas` | funciona; traz `assignmentId`, `studentId`, `evaluatedAt`, `academicTermId` |

E aqui está a boa notícia que faltava: **existe valor numérico**. O campo
`assessmentToolData` vem em três formas:

```jsonc
{ "score":  [{ "value": "62", "maxScore": "66" }] }              // numérico
{ "rubric": [{ "value": "Exemplary…", "criteriaLabel": "…" }] }  // alfabético
{ "score":  [...], "rubric": [...] }                             // os dois
```

O `score` casa com `SNotas.NOTA` e o `maxScore` com `SProvas.NOTAMAXIMA`. O
`rubric` reencontra o problema de letra→número, agora por avaliação.

Os 223 assignments por tipo:

| `assessmentType/subAssessmentType` | quantos |
|---|---|
| `learning_engagement/le` | 111 |
| `assessment/fmt` | 38 |
| `learning_engagement/` | 30 |
| `assessment/pt` | 16 |
| `ai_tutor/ai_tutor` | 12 |
| `worksheet/worksheet` | 6 |
| `assessment/pri` | 6 |
| `assessment/` | 4 |

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

## 5. O próximo passo, e ele é barato

A pergunta **6** é a que destrava tudo, e dá para responder sozinho no sandbox
sem tocar em dado de ninguém:

1. Na `IDTURMADISC 1250` — que tem **zero** provas e **zero** notas, então não há
   trabalho humano em risco — criar UMA prova via `EduProvasData`.
2. Lançar UMA nota nela via `EduNotasData`.
3. Reler `SNOTAETAPA` e ver se a etapa deixou de ser `0.0000`.

Se a etapa recalcular, o desenho está provado e o resto é de-para. Se não
recalcular, a pergunta vira "como se dispara o recálculo?" — e aí é ticket na
TOTVS antes de qualquer código.

**Este teste escreve estrutura no RM (uma prova). Não foi executado: precisa de
autorização.**

---

## 6. O que está pronto e continua servindo

Na branch `feat/nota-agendada`, tudo isto independe do destino e é reaproveitável:

- leitura e achatamento do Toddle, projeção com 10 recusas, montagem de XML
- os quatro guardas (projeção, decisão, pendência, teto+gate de aprovação)
- o job agendado, o poll com interruptor de duas vias e o preflight
- 120 testes

O que muda quando a pergunta 6 for respondida: o **montador de XML** (dois
datasets em vez de um), o **de-para de avaliação** (novo tipo na `id_mapping`) e
o **leitor do Toddle** (`student-assignments` em vez de `term-grades`).

> ⚠️ **Rastro deixado por este levantamento no sandbox**
>
> - `SNOTAETAPA` chave `1|1|N|1250|202600199`: linha criada por mim, valor
>   `0.0000`. Não existia antes. Indistinguível das outras 21 daquela turma, que
>   também são zero, e não há `DELETE` pelo DataServer.
> - Toddle: duas notas de teste no T1 — `6` para o RA 202600053 (Geografia) e `5`
>   para o RA 202600199 (Orientação de Estudos). O `POST` é upsert e a API não
>   expõe remoção.
