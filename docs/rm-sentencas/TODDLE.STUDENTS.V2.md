# TODDLE.STUDENTS.V2 — contrato da Sentença

Documentação do `TODDLE.STUDENTS.V2.sql`. **Nada daqui vai para dentro da
Sentença.** O `.sql` ao lado é o que se cola no RM, e ele é deliberadamente
sem um único comentário.

## Por que sem comentário nenhum

O RM normaliza o texto da Sentença ao salvar e colapsa quebras de linha. Com
isso `--` deixa de comentar até o fim da linha e passa a comentar **até o fim
da query**. O RM reparsa o SQL para atualizar os registros-filhos da Sentença
(lista de colunas e de parâmetros), não encontra coluna nenhuma, e o UPDATE
desses filhos falha com:

```
Concurrency violation: the UpdateCommand affected 0 of the expected 1 records.
```

A mensagem é de concorrência do ADO.NET, mas a causa é o comentário. Bloco
`/* */` também é evitado: além do risco do mesmo colapso, o parser do RM lê
`:` como início de parâmetro, e comentário em prosa quase sempre acaba tendo
um.

Regra: **`.sql` = artefato de máquina, `.md` = artefato de gente.**

## Cadastro no RM

Cadastrar como Sentença **nova**, código `TODDLE.STUDENTS.V2`, sem
sobrescrever a `TODDLE.STUDENTS` atual. Além de manter fallback, um INSERT não
tem cláusula de concorrência otimista para falhar — se a Sentença atual ficou
em estado meio-salvo, criar a nova contorna o problema em vez de brigar com o
UPDATE.

Parâmetros a declarar na aba Parâmetros:

| Parâmetro | Tipo | Valor |
|---|---|---|
| `CODCOLIGADA` | Inteiro | `1` |
| `CODPERLET` | **Texto** | `2026` |

`CODPERLET` é alfanumérico em `SPLETIVO`. Declarar como Inteiro força
conversão implícita.

Chamada pelo `wsConsultaSQL`:

```
codSentenca = TODDLE.STUDENTS.V2
codColigada = 1
codSistema  = S
parameters  = CODCOLIGADA=1;CODPERLET=2026
```

Depois de cadastrar, apontar `RM_SENTENCA_STUDENTS=TODDLE.STUDENTS.V2` no
`.env` e testar isolado com `./docs/rm-sentencas/testar-sentenca.sh`.

## Contrato de colunas

Os apelidos são casados por `pick()` em `rmStudentSource.ts`, case-insensitive.
**Renomear coluna aqui quebra o middleware em silêncio.**

| Coluna | Origem | Papel no middleware |
|---|---|---|
| `RA` | `SALUNO.RA` | obrigatória — `sourceId` |
| `NOME_COMPLETO` | `PPESSOA.NOME` | obrigatória — split em firstName/lastName |
| `CODINTERNO` | `SALUNO.CODPESSOA` | informativa — `StudentInternalId` |
| `CODFILIAL` | `SMATRICPL.CODFILIAL` | **obrigatória** — filtro `RM_CODFILIAL` |
| `COD_TURMA` | `SMATRICPL.CODTURMA` | chave do de-para de year group |
| `NOME_TURMA` | `STURMA.NOME` | leitura humana no de-para |
| `PERIODO_SERIE` | `SMATRICPL.PERIODO` | **inutilizável** — ver abaixo |
| `NIVEL_ENSINO` | `STIPOCURSO.NOME` | ver abaixo |
| `CODPERLET` / `PERIODO_LETIVO` | `SPLETIVO` | `TermCode` |
| `EMAIL` / `EMAIL_PESSOAL` | `PPESSOA` | enriquecimento; institucional tem precedência |
| `DTNASCIMENTO` | `PPESSOA` | enriquecimento; middleware normaliza p/ `YYYY-MM-DD` |
| `SEXO` | `PPESSOA` | enriquecimento; só `M`/`F` passam |
| `STATUS_MATRICULA` | `SMATRICPL.CODSTATUS` | `TermStatus` |
| `STATUS_DESCRICAO` | `SSTATUS.DESCRICAO` | diagnóstico |
| `STATUS_ATIVO` | `SSTATUS.PLATIVO` | `IsActiveTerm` — decide aluno ativo |

`CODFILIAL` é a que quebrou antes: sem ela no SELECT, com `RM_CODFILIAL=2`, o
extract descarta as 586 linhas como fora do escopo e o sync roda com 0 aluno,
logando `foraDoEscopo=586`.

Checklist ao mexer no código: todo `pick()` novo em `rmStudentSource.ts`
precisa ter apelido correspondente neste SELECT.

## Histórico sobre a versão anterior

1. `TOP 30` removido — truncava o roster em 30 alunos / 2 turmas.
2. `CODCOLIGADA` e `CODPERLET` viraram parâmetros, não valores fixos.
3. Colunas de enriquecimento (`EMAIL`, `EMAIL_PESSOAL`, `DTNASCIMENTO`,
   `SEXO`) e `CODINTERNO` adicionadas.
4. `SSTATUS` juntado para expor `DESCRICAO` e `PLATIVO`, em vez de adivinhar
   qual `CODSTATUS` é ativo.
5. `CODFILIAL` adicionada ao SELECT.
6. Todos os comentários removidos do `.sql`.

## `PERIODO_SERIE` é uma armadilha, não uma coluna vazia

A documentação anterior dizia "vem NULL em TODAS as linhas", conclusão tirada
de uma rodada com `TOP 30`. **Está errado.** No retorno completo, `PERIODO` vem
preenchido — mas **só nas matrículas canceladas**.

Amostra conferida na turma EAVHS10IA: as três únicas linhas com `PERIODO = 1`
são exatamente as três com `STATUS_MATRICULA = 17` / `Cancelado - Rematrícula`
/ `STATUS_ATIVO = N`. Todas as linhas `Matriculado` vêm com `PERIODO` vazio.

Consequência: usar `PERIODO` como fallback de série produz valor **somente
para aluno inativo** — o inverso do que se quer. A coluna fica no SELECT como
sentinela: se um dia ela passar a vir preenchida nas linhas ativas, aí sim
vira chave de série candidata. Até então, a chave é `COD_TURMA`.

## `NIVEL_ENSINO` provavelmente é peso morto

Vem `Ensino Básico` em todas as linhas conferidas — um `STIPOCURSO`
guarda-chuva, não Infantil/Fundamental/Médio como a doc anterior prometia.
A amostra é de uma turma só, então não é conclusivo. Se ao varrer as 34 turmas
o valor for constante, a coluna pode sair do SELECT.

O que de fato segmenta é o próprio `COD_TURMA`: `EAV` + segmento + série +
turno + seção. `EAVHS10IA` = HS (High School) + 10 + I + A;
`EAVPS05IB` = PS (Primary School) + 05 + I + B.



**Fan-out do `SSTATUS`.** O join é só por `CODCOLIGADA + CODSTATUS`, mas
`SSTATUS` tem `CODTIPOCURSO` — se a escola configurou status por nível de
ensino, a linha do aluno multiplica. Não mexi sem ver o dado. O teste é de
graça no log do extract: se `linhas` ≠ `alunos` + `foraDoEscopo`, é
duplicação, e a deduplicação por RA está absorvendo sem reclamar.

**Filtro de ativo não está no SQL.** Quem decide é o `PLATIVO` lido pelo
middleware. Se um dia for preciso filtrar aqui, o valor materializa como
`'S'`/`'N'` nesta base — e a linha entra **sem** comentário explicativo.

**Divergência na definição de ativo.** `PLATIVO='S'` cobre quatro status aqui
(Matriculado, Matrícula em andamento, Matrícula não enturmado, Aluno
Visitante). A query do Destiny, na mesma base, usa `CODSTATUS IN (1,2,20)` —
três códigos. Uma das duas está errada.

**Desempate arbitrário.** `ORDER BY T.NOME, P.NOME` faz a turma
alfabeticamente primeira ganhar quando um RA tem duas linhas *ambas* ativas —
e isso decide o year group do aluno. Só é problema se existir esse caso, o que
o mesmo teste de fan-out revela.

**Escopo de campus não decidido.** O `.env` real está com `RM_CODFILIAL` vazio
(log do extract sai `campi: "todos"`), então as 586 linhas entram — incluindo
o `CODFILIAL=1` que esta doc diz estar fora. As cinco turmas na DLQ por falta
de mapeamento são todas `PS` (Primary School): `EAVPS05IA`, `EAVPS05IB`,
`EAVPS02MB`, `EAVPS02IB`, `EAVPS01IA`. Ou preenche `RM_CODFILIAL=2` e a DLQ
zera por decisão de escopo, ou mapeia as cinco — mas não os dois.
