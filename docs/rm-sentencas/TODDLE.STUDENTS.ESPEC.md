# Especificação — Sentença `TODDLE.STUDENTS`

Roster de alunos do Fluxo 1. Consumida por
`packages/domain/src/rmStudentSource.ts` via `wsConsultaSQL`. O middleware a chama
por `RM_SENTENCA_STUDENTS=TODDLE.STUDENTS`.

Nomes de tabela e coluna **conferidos no dicionário do RM** (skill `totvs-rm`,
8.521 tabelas / 127.357 colunas); os JOINs vieram da `GLINKSREL`, ou seja, são os
relacionamentos reais.

> **Consolidação de 20/08/2026.** Existiam três SQL nesta pasta —
> `TODDLE.STUDENTS.sql` (anotado), `.V2.sql` e `.V3.sql`. A canônica é a **V3**, e
> é ela que está hoje em `TODDLE.STUDENTS.sql`. O critério não foi o número da
> versão: **só a V3 traz `CODCURSO`**, que `rmStudentSource.ts:86` lê como
> `CourseCode`, o fallback de year group. A V2 não tinha, e por isso não serve.
> A V3 também troca `PERIODO_SERIE` pelas colunas de matriz/curso (ver §4).

## 1. Parâmetros — são DOIS

| parâmetro | valor no `.env` |
|---|---|
| `CODCOLIGADA` | `RM_CODCOLIGADA=1` |
| `CODPERLET` | `RM_CODPERLET=2026` |

## 2. Correções que moldaram esta Sentença (2026-07-31)

Sobre a versão que estava em produção:

1. **REMOVIDO o `TOP 30`.** Truncava o roster — devolvia 30 alunos em 2 turmas, e
   a turma `EAVHS10IB` vinha cortada no 7º aluno por causa do `ORDER BY`. É o erro
   mais caro desta pasta, porque falha **em silêncio**: a Sentença responde 200,
   com dado plausível. **Nunca acrescente `TOP` nem `LIMIT` aqui.**
2. **`CODCOLIGADA` e `CODPERLET` passaram a vir dos PARÂMETROS**, não hardcoded.
   Com valor fixo, a virada de ano letivo exigiria editar a Sentença no RM.
3. **Adicionadas as colunas de enriquecimento** (`EMAIL`, `DTNASCIMENTO`, `SEXO`) e
   a chave interna `CODINTERNO`, que o middleware lê como opcionais.
4. **Matrícula ativa:** em vez de adivinhar qual `CODSTATUS` é "ativo", o JOIN com
   `SSTATUS` expõe `DESCRICAO` e o flag `PLATIVO` ("Indica se está ativo no P.
   Letivo"). Ver §5.
5. **Adicionada `CODFILIAL`.** Não é decorativa — ver §3.

## 3. `CODFILIAL` é obrigatória, e o motivo dói

O escopo é **só o campus do aeroporto** (`CODFILIAL=2`, Fundamental II + Médio). O
campus 1 (Infantil + Fundamental I) fica fora do Toddle.

O filtro é feito **no middleware** (`RM_CODFILIAL` no `.env`), e é por isso que a
coluna tem de estar no SELECT: `rmStudentSource.ts` faz `pick(row,'CODFILIAL')` e
**descarta toda linha sem esse valor** quando `RM_CODFILIAL` está preenchido. Sem
a coluna, o roster inteiro cai como fora do escopo — 586 → 0 alunos, com
`foraDoEscopo=586` no log.

Filtrar **também** no SQL é opcional e só economiza tráfego (586 → 295). Se for
fazer, declare `CODFILIAL` como parâmetro da Sentença e **mantenha a coluna no
SELECT de qualquer forma**:

```sql
  AND  M.CODFILIAL = :CODFILIAL
```

## 4. `PERIODO_SERIE` não serve como série — e a V3 tirou

Correção de 2026-07-31, do retorno completo: `M.PERIODO` **não** vem NULL em todas
as linhas. Vem preenchido **só nas matrículas CANCELADAS** (`CODSTATUS 17`); nas
ativas vem vazio. Usar como fallback de série daria valor apenas para aluno
inativo — exatamente o inverso do útil.

Enquanto `M.PERIODO` não for populado no RM, a série **não** serve como chave de
year group. Use `COD_TURMA` ou `NOME_TURMA`. A V3 substituiu essa coluna pelas de
matriz curricular: `ID_MATRIZ`, `CODCURSO`, `NOME_CURSO`, `CODHABILITACAO`,
`NOME_HABILITACAO`, vindas de `SHABILITACAOFILIAL`.

**Coluna ausente no XML = valor nulo, não "Sentença sem a coluna".** O DataSet do
.NET omite a coluna quando o valor é nulo. Isso já causou diagnóstico errado mais
de uma vez.

## 5. Filtro de matrícula ativa — deliberadamente fora do SQL

O dicionário do RM **não traz tipos**, então não se sabe de antemão se `PLATIVO`
se materializa como `1/0` ou `'T'/'F'` nesta base. Duas saídas:

- descomentar no SQL, depois de conferir na primeira execução:
  ```sql
    AND  ST.PLATIVO = 1
  ```
- **ou** (preferido) deixar o SQL sem filtro e preencher `RM_ACTIVE_TERM_STATUSES`
  no `.env`, que filtra pelo mesmo `CODSTATUS` — revisável sem mexer no RM.

A Sentença devolve os flags de diagnóstico (`STATUS_MATRICULA`,
`STATUS_DESCRICAO`, `STATUS_ATIVO`) justamente para permitir a segunda saída.

## 6. Os apelidos são contrato

`pick()` em `rmStudentSource.ts` casa por nome, case-insensitive, com
alternativas. **Não renomeie coluna sem ajustar o código.** Verificado no XML cru
em 2026-07-31: `RA`, `NOME_COMPLETO`, `COD_TURMA`, `NOME_TURMA`,
`STATUS_MATRICULA`, `CODPERLET` e `PERIODO_LETIVO` vêm preenchidas.

## 7. `MajorStatus` não tem coluna — e está certo assim

`rmStudentSource.ts:91` faz `pick(row, 'STATUSCURSO', 'MAJORSTATUS')` e **nenhum
dos dois existe nesta Sentença**. Não é lacuna:

- `STATUSCURSO` no RM só existe em `SCVFORMACAOACADEMICA` (currículo/formação
  acadêmica), que nada tem a ver com status de matrícula. Não há de onde tirar.
- `MAJORSTATUS` é nome da API TOTVS, para outra instalação.
- `studentSync.processor.ts:157` resolve `ctx.TermStatus ?? ctx.MajorStatus`, e
  `TermStatus` vem de `STATUS_MATRICULA`, que **está** presente. O fallback nunca
  dispara.

Não invente uma coluna para preencher esse `pick`.

## 8. Tabelas

| tabela | papel |
|---|---|
| `SALUNO` | aluno; `RA` e `CODPESSOA` |
| `PPESSOA` | nome, e-mail, nascimento, sexo |
| `SMATRICPL` | matrícula no período letivo; turma, campus, status |
| `SPLETIVO` | traduz `CODPERLET` ↔ `IDPERLET` |
| `STURMA` | nome da turma |
| `SSTATUS` | "Status de Matrícula": `DESCRICAO` + `PLATIVO` |
| `STIPOCURSO` | "Nível de Ensino" → `NIVEL_ENSINO` |
| `SHABILITACAOFILIAL` | curso/habilitação → `CODCURSO` e afins |

---

## Validação de 20/08/2026 — recadastrada e medida

Depois de a cópia de base de 13–15/08 levar as Sentenças, esta foi recolada e
executada (`CODCOLIGADA=1;CODPERLET=2026`):

| verificação | resultado |
|---|---|
| linhas | 597 |
| chave `RA` | 590 distintas — **7 duplicadas** |
| `CODFILIAL` | campus 2: 299 linhas / **296 RA**; campus 1: 298 |
| `STATUS_ATIVO` | `S` 520, `N` 77 |
| `CODCURSO` | `ES` 196, `MS` 182, `HS` 117, `PS` 102 |
| `NIVEL_ENSINO` | **constante** — "Ensino Básico" em 100% |
| `EMAIL` | preenchido em 573 de 597 |

**Os 7 RA duplicados são troca de turma, não fan-out.** Cada um tem uma matrícula
ativa e uma inativa:

```
RA 202600009: EAVES02IA status=8 ativo=N | EAVES03IB status=1 ativo=S
RA 202600122: EAVES05IB status=8 ativo=N | EAVMS06IB status=2 ativo=S
RA 202600085: EAVHS10IA status=2 ativo=S | EAVHS11IA status=18 ativo=N
```

O middleware deduplica por RA, então é absorvido — **mas ele escolhe entre as duas
linhas**, e escolher a inativa põe o aluno na turma errada. É para isso que existe
`RM_ACTIVE_TERM_STATUSES` no `.env`. A alternativa estrutural é trocar o
`LEFT JOIN SSTATUS` por `OUTER APPLY ... TOP 1`, como a `TODDLE.NOTAS` faz — lá a
chave saiu única.

**Duas colunas vêm sempre nulas:** `NOME_CURSO` e `NOME_HABILITACAO`. As descrições
de `SHABILITACAOFILIAL` estão vazias nesta base, então **`CODCURSO` é o único
discriminador de currículo utilizável** — e `NIVEL_ENSINO`, sendo constante, não
serve para nada.
