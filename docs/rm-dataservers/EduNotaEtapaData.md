# `EduNotaEtapaData` — leitura e escrita da nota de etapa no RM

O DataServer da **nota do trimestre** (`SNOTAETAPA`). Com a decisão D1 — nota vem
do Toddle para o TOTVS — é por ele que a nota será gravada.

Levantado em **06/08/2026** por `GetSchema` no RM de **desenvolvimento**
(`wsDataServer`, porta 1951), coligada 1 / filial 2.

> **Convenção:** o que foi **medido** está afirmado direto. O que não foi
> verificado está dito. Não há terceira categoria.

---

## 1. O dataset tem duas tabelas

Raiz do dataset: `SNotaEtapa` e `SNotaEtapaComentario`.

### `SNotaEtapa` — a nota

| campo | tipo | obrigatório |
|---|---|---|
| `CODCOLIGADA` | `xs:short` | **sim** |
| `CODETAPA` | `xs:short` | **sim** |
| `TIPOETAPA` | `xs:string` | **sim** |
| `IDTURMADISC` | `xs:int` | **sim** |
| `RA` | `xs:string` | **sim** |
| `IDGRUPO` | `xs:short` | não |
| `CODCONCEITO` | `xs:string` | não |
| **`NOTAFALTA`** | `xs:decimal` | não |
| `AULASDADAS` | `xs:short` | não |
| `CONCEITOECTS` | `xs:string` | não |

**Os cinco obrigatórios são exatamente os que já resolvemos** — o de-para de aluno
e turma-disciplina, mais o `CODETAPA` que vem do `GRADING_PERIOD` (migração 008).

### `SNotaEtapaComentario`

Mesmos cinco obrigatórios, mais `CODPROVA`. Serve para comentário por avaliação, e
não está no escopo hoje.

## 2. `NOTAFALTA` é o valor, e é discriminado por `TIPOETAPA`

O campo é **um só** para nota e falta:

| `TIPOETAPA` | o que `NOTAFALTA` significa |
|---|---|
| `'N'` | a **nota** da etapa (escala 0 a 7 nesta escola) |
| `'F'` | o **número de faltas** da etapa |

Isso explica o que eu havia estranhado na leitura: a view do `ReadView` devolve
`NOTA` e `FALTA` como colunas separadas, mas o armazenamento é um campo único
discriminado pelo tipo.

**Consequência prática:** escrever nota é `TIPOETAPA='N'`. Mandar `'F'` por engano
grava um total de faltas no lugar da nota — e o total de faltas alimenta o cálculo
de reprovação por frequência.

## 3. NÃO há chave primária declarada no XSD

Diferente do `EduFrequenciaDiariaWSData`, que declara
`msdata:PrimaryKey` com os cinco campos da chave natural, **este schema não declara
nenhuma**.

A chave natural aparente é `CODCOLIGADA + CODETAPA + TIPOETAPA + IDTURMADISC + RA`
— e ela **é única no dado real**: medido em `TODDLE.NOTAS`, 3.876 chaves para 3.876
linhas.

Mas sem declaração no schema, **a deduplicação é inteiramente nossa**, e não há
garantia de que o RM rejeite duplicata. Mesma classe de problema do
`EnforceConstraints="False"` da frequência, um grau pior.

## 4. `AULASDADAS` aparece aqui também

Mesma armadilha documentada em `EduFrequenciaDiariaWSData.md` §4: é o denominador
da frequência mínima (75% nesta escola). Opcional no XSD — **omitir**.

Escrever valor errado ali não erra um registro de nota: altera cálculo de
reprovação por falta.

## 5. `CODCONCEITO` — a escola não usa

`CODCONCEITO` e `CONCEITOECTS` permitem gravar conceito em vez de número. Medido em
`TODDLE.NOTAS`: `COD_CONCEITO` preenchido em **0 de 3.876** linhas, e as colunas de
faixa (`CONCEITO_NOTA_INI`/`FIM`) também vazias.

**Não existe régua oficial de número para letra no RM desta escola.** Por isso a
nota trafega numérica, e no Toddle vai como *overall score* (só `postedGrade`, sem
`gradeScaleId`).

## 6. Leitura — o que a view devolve

`ReadView` com elemento-linha **`SNotaEtapa`** (case misto). Filtro SQL funciona,
com nome qualificado:

```
SNotaEtapa.CODCOLIGADA=1 AND SNotaEtapa.IDTURMADISC IN (…)
```

Exige **lotes de ~25 `IDTURMADISC`** — `IN` grande estoura. Foi assim que medi as
16.112 linhas iniciais.

A view devolve mais que a tabela: `NOMEALUNO`, `DISCIPLINA`, `ETAPA`, `NOTA`,
`FALTA`, `CODETAPAFALTA`, `ETAPAFALTA`, `AULASDADAS`, `AULASDADASETAPA`, `STATUS`.

**Não devolve `CODFILIAL`** — foi o argumento mais forte para preferir a Sentença
`TODDLE.NOTAS`, que traz o campus e permite recorte fail-closed direto.

## 7. Antes do primeiro `SaveRecord`

Nada foi escrito por aqui ainda. O cliente do `wsDataServer`
(`packages/integrations/src/rm-soap/wsDataServerClient.ts`) **não tem método de
escrita, de propósito** — ver o comentário no topo dele.

Checklist, na ordem:

1. **Shadow mode primeiro.** Ler o `GET /term-grades` do Toddle, resolver os alvos
   no RM, montar o XML e mostrar o que *seria* enviado. Zero escrita.
2. **Autorizar por interseção positiva** — aluno, turma-disciplina e etapa com
   mapeamento ativo; tenant, campus, coligada, filial e `configVersion` coincidindo.
3. **Corrigir as datas dos grading periods** antes de qualquer escrita de nota. Ver
   D2 em `docs/DECISOES.md`: hoje uma nota de junho viraria etapa 1.
4. **Testar se `AULASDADAS` omitido é aceito.** Opcional no XSD não garante
   opcional na regra de negócio.
5. **`ETAPAENCERRADA` e `DTLIMITEDIGITACAO`** — o `SETAPAS` tem os dois. Escrever em
   etapa fechada é alterar registro acadêmico fechado; hoje todas estão `'N'`
   porque é o ambiente de desenvolvimento, e em produção será diferente.
6. **HTTP 200 não é sucesso.** O RM devolve erro no corpo, com stack trace .NET.

## 8. Relacionado

- `EduFrequenciaDiariaWSData.md` — a escrita de frequência, e as armadilhas comuns
  (fuso da data, HTTP 200 com erro, case misto do elemento-linha)
- `../rm-sentencas/TODDLE.NOTAS` (a Sentença) — a leitura com `CODFILIAL`
- `../DECISOES.md` — D1 (direção Toddle → RM) e D2 (ordinal das etapas)
