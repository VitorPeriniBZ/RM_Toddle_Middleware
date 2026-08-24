# Especificação — Sentença `TODDLE.NOTAS`

> **Estado: cadastrada e validada em 20/08/2026.** Esta Sentença nunca foi
> commitada neste repositório — só existiu dentro do RM, e a cópia de base de
> 13–15/08 a levou. O SQL foi **reconstruído** a partir do contrato que
> `rmGradeSource.ts` espera, conferido no dicionário, ajustado pelo Vitor no
> cadastro, e **validado na execução**: 7.268 linhas, chave única. Ver §6.

## 1. Para que serve

Alimenta `POST /public/v2/term-grades` no Toddle — nota de etapa por aluno, por
turma-disciplina. Consumida por `packages/domain/src/rmGradeSource.ts`
(`fetchNotasFromRm`), exercitada por `npm run ler:notas` (somente leitura).

O middleware a chama por `RM_SENTENCA_NOTAS=TODDLE.NOTAS`.

**Não serve para escrever no RM.** A via de escrita de nota é o DataServer
`EduNotaEtapaData` (ver `docs/rm-dataservers/EduNotaEtapaData.md`).

## 2. Parâmetros — são DOIS

| parâmetro | valor no `.env` | observação |
|---|---|---|
| `CODCOLIGADA` | `RM_CODCOLIGADA=1` | Inteiro |
| `CODPERLET` | `RM_CODPERLET=2026` | **Texto**; ano letivo, não `IDPERLET` |

São exatamente os dois que `fetchNotasFromRm` envia:

```ts
await wsConsultaSqlClient.realizarConsulta(env.RM_SENTENCA_NOTAS, {
  CODCOLIGADA: env.RM_CODCOLIGADA,
  CODPERLET: env.RM_CODPERLET,
});
```

Acrescentar um terceiro parâmetro obrigatório **quebra o middleware**, que não o
enviaria. E parâmetro é `:NOME` — o TOTVS recusa `@NOME`.

## 3. Tabelas — conferidas no dicionário

Nomes e chaves de JOIN saíram do dicionário do RM (skill `totvs-rm`) e da
`GLINKSREL`, não de memória:

| tabela | descrição no dicionário | papel |
|---|---|---|
| `SNOTAETAPA` | "Notas nas Etapas da Turma Disciplina" | a nota. 15 colunas |
| `SETAPAS` | "Etapas" | a etapa e o flag de liberação |
| `STURMADISC` | Turma/Disciplina | turma, disciplina, campus |
| `SMATRICULA` | matrícula na turma-disciplina | status do aluno *naquela turma* |
| `SSTATUS` | "Status de Matrícula" | `DESCRICAO` + `PLATIVO` |
| `SDISCIPLINA` | Disciplina | `NOME` |
| `SCONCEITO` | "Conceito" | **só faixa numérica** — ver aviso abaixo |
| `SPLETIVO` | Período letivo | traduz `CODPERLET` ↔ `IDPERLET` |

Os JOINs de `SNOTAETAPA` para `SETAPAS`, `SMATRICULA` e `SCONCEITO` são os que a
**`GLINKSREL` devolve**, com as chaves compostas completas:

- `SETAPAS`: `CODCOLIGADA + IDTURMADISC + CODETAPA + TIPOETAPA` — as quatro. Casar
  só `CODETAPA` provoca fan-out entre tipos de etapa.
- `SMATRICULA`: `CODCOLIGADA + IDTURMADISC + RA`.
- `SCONCEITO`: `CODCOLIGADA + IDGRUPO + CODCONCEITO`.

`SNOTAETAPA → STURMADISC` **não tem link na GLINKSREL**; entra por
`CODCOLIGADA + IDTURMADISC`, o mesmo par que `TODDLE.TURMADISC` usa com sucesso.

> ⚠️ **`SCONCEITO` não tem coluna `DESCRICAO`.** Ela tem 9 colunas: `CODCOLIGADA`,
> `CODCONCEITO`, `IDGRUPO`, **`NOTAINI`**, **`NOTAFIM`** e as 4 de auditoria. A
> primeira versão desta Sentença pedia `CO.DESCRICAO` e teria falhado no cadastro
> por coluna inválida. O conceito, aqui, é uma **faixa numérica**, não um rótulo.

### O `OUTER APPLY` no `SSTATUS` não é enfeite

`SSTATUS` tem `CODTIPOCURSO` ("Código do Nível de Ensino"), mas o JOIN natural é só
por `CODCOLIGADA + CODSTATUS`. Se a escola configurar status por nível de ensino, a
linha da nota **multiplica**. O `OUTER APPLY ... TOP 1` elimina isso, e é o mesmo
padrão que salva a `TODDLE.FREQ` do fan-out em `SHORARIO`.

Medido: chave única, 7.268 para 7.268. Comparar com a `TODDLE.STUDENTS`, que ainda
usa `LEFT JOIN SSTATUS` e devolve 7 RA duplicados.

**Melhoria conhecida, ainda não aplicada:** o `ORDER BY S.CODTIPOCURSO` desempata
de forma arbitrária — não garante o status do nível de ensino *daquela* turma. Como
`STURMA.CODTIPOCURSO` existe, o desempate correto seria preferir a linha que casa,
como a `TODDLE.FREQ` faz com `IDPERLET`:

```sql
ORDER BY CASE WHEN S.CODTIPOCURSO = T.CODTIPOCURSO THEN 0 ELSE 1 END
```

Só vale mexer se `STATUS_DESCRICAO` aparecer incoerente; hoje não aparece.

## 4. Colunas e o de-para com o código

`rmGradeSource.ts` casa por nome via `pick()`, **case-insensitive e com
alternativas**. Os apelidos abaixo não podem ser renomeados sem ajustar o código.

| coluna na Sentença | origem | lida como | obrigatória? |
|---|---|---|---|
| `CODCOLIGADA` | `SNOTAETAPA.CODCOLIGADA` | `codColigada` | sim |
| `RA` | `SNOTAETAPA.RA` | `ra` | sim |
| `ID_TURMADISC` | `SNOTAETAPA.IDTURMADISC` | `idTurmaDisc` (aceita `IDTURMADISC`) | sim |
| `CODETAPA` | `SNOTAETAPA.CODETAPA` | `codEtapa` (aceita `COD_ETAPA`) | sim |
| `TIPOETAPA` | `SNOTAETAPA.TIPOETAPA` | (aceita `TIPO_ETAPA`) | sim |
| `ETAPA` | `SETAPAS.DESCRICAO` | `etapa` | sim |
| `NOTA` | `SNOTAETAPA.NOTAFALTA` | `nota` | sim |
| `ETAPA_LIBERADA` | `SETAPAS.DISPONIVELALUNOS` | `etapaLiberada` | sim |
| `CODFILIAL` | `STURMADISC.CODFILIAL` | `codFilial` | **sim — ver §5** |
| `COD_TURMA` | `STURMADISC.CODTURMA` | `codTurma` (aceita `CODTURMA`) | não |
| `CODDISC` | `STURMADISC.CODDISC` | `codDisc` | não |
| `DISCIPLINA` | `SDISCIPLINA.NOME` | `disciplina` | não |
| `STATUS_ATIVO` | `SSTATUS.PLATIVO` | `alunoAtivo` | sim |
| `STATUS_DESCRICAO` | `SSTATUS.DESCRICAO` | `statusDescricao` | não |
| `CRIADO_POR` | `SNOTAETAPA.RECCREATEDBY` | `criadoPelaIntegracao` | sim |
| `CRIADO_EM` | `SNOTAETAPA.RECCREATEDON` | `criadoEm` | não |
| `ALTERADO_EM` | `SNOTAETAPA.RECMODIFIEDON` | `alteradoEm` — **marca d'água** | sim |

Presentes no SELECT mas **não lidas** hoje: `STATUS` (`SMATRICULA.CODSTATUS`),
`ALTERADO_POR`, `CODPERLET`, `ETAPA_DT_INICIO`, `ETAPA_DT_FIM`, `AULAS_DADAS`,
`COD_CONCEITO`, `ID_GRUPO_CONCEITO`, `CONCEITO_NOTA_INI`, `CONCEITO_NOTA_FIM`.
Custam zero e respondem perguntas que já apareceram (a janela da etapa fechou?).

**Das não lidas, cinco vêm sempre nulas** — medido em 20/08: `AULAS_DADAS`,
`COD_CONCEITO`, `ID_GRUPO_CONCEITO`, `CONCEITO_NOTA_INI`, `CONCEITO_NOTA_FIM`. O
DataSet do .NET omite coluna nula, então elas nem aparecem no XML. **Coluna ausente
= valor nulo, não Sentença incompleta.**

`ehSim()` no código aceita `S`, `SIM`, `1`, `TRUE` — o RM pode materializar o flag
de qualquer uma dessas formas, e nenhuma quebra.

## 5. O recorte é do middleware — com uma exceção no SQL

A Sentença devolve **tudo** da coligada + período letivo. Todo recorte de escopo é
do middleware:

- **campus** — `RM_CODFILIAL` (`fail-closed`). É por isso que `CODFILIAL` é
  obrigatória no SELECT: `rmGradeSource` descarta toda linha sem esse valor. A
  Sentença de alunos já perdeu o roster inteiro (586 → 0) por falta dessa coluna.
- **turma e aluno** — interseção positiva contra o de-para (`COURSE` e `STUDENT`
  ativos). Lista vazia é **erro**, nunca "ler tudo".
- **etapa liberada** — o módulo **marca** e não filtra, de propósito.

**A exceção legítima é `AND NE.TIPOETAPA = 'N'`.** Não é recorte de escopo: é
escolha do *tipo de registro*. O `SNOTAETAPA.NOTAFALTA` guarda nota **ou** falta
conforme o `TIPOETAPA`, então sem esse filtro a Sentença misturaria as duas coisas
na mesma coluna. Validado em 20/08: `TIPOETAPA='N'` em 100% das 7.268 linhas
devolvidas, ou seja o filtro está no valor certo e não zerou o resultado.

**Não acrescente `TOP` nem `LIMIT`.** A Sentença de alunos nasceu com
`SELECT TOP 30` e truncou o roster em silêncio: apareciam 2 turmas de 185.

## 6. O que foi MEDIDO em 20/08/2026

Execução real, `CODCOLIGADA=1;CODPERLET=2026`:

| verificação | resultado |
|---|---|
| linhas | **7.268** |
| chave `(RA, ID_TURMADISC, CODETAPA)` | 7.268 distintas — **zero duplicadas** |
| `TIPOETAPA` | `'N'` em 100% |
| faixa da nota | **0,0 a 7,0**, 328 valores distintos |
| linhas sem nota (etapa aberta) | 237 |
| `ETAPA_LIBERADA` | `'N'` em 100% |
| `ETAPA` | Primeiro Trimestre 6.100, Segundo Trimestre 1.168 |
| `STATUS_ATIVO` | `S` 6.913, `N` 355 |
| `CODFILIAL` | campus 2: **4.428**, campus 1: 2.840 |

Comparado com a medição de 05/08 (3.876 linhas, só Primeiro Trimestre): o
crescimento é o Segundo Trimestre entrando, **não fan-out** — a chave continua
única. Nota máxima segue 7,0, escala inalterada.

### O que isso decide

1. **A nota é numérica, de 0 a 7.** As duas escalas do Toddle são alfabéticas
   (EXEM/EXC/… e A–E) e a tabela de conceito do RM está **vazia**
   (`COD_CONCEITO` nulo em 100%). Sem régua oficial de número→letra, a nota vai
   como *overall score*: só `postedGrade`, sem `gradeScaleId` e sem
   `criteriaType`, que é o que a API permite.
2. **`ETAPA_LIBERADA = 'N'` em 100% — nada é publicável sob a regra segura.**
   Publicar nota não liberada mostra à família resultado provisório. O módulo
   **marca** cada nota e deixa a decisão para quem consome, porque ainda não se
   sabe se a flag é gerenciada nesta escola ou se nunca é tocada. Isso não mudou
   entre 05/08 e 20/08.
3. **355 notas são de aluno com matrícula inativa** naquela turma-disciplina
   (`STATUS_ATIVO='N'`). O `lerNotas.ts` já as recusa com motivo `ALUNO_INATIVO`.
4. O de-para de etapa é por **ordinal** (etapa 1 → T1), não por data: as janelas
   do Toddle e do RM divergem. Ver migração 008.

Para reproduzir:

```bash
./docs/rm-sentencas/testar-sentenca.sh TODDLE.NOTAS
npm run ler:notas                 # somente leitura, mostra o que iria pro Toddle
```

## 7. O que NÃO fazer

- **Não filtrar por `ETAPA_LIBERADA` dentro do SQL.** Esconde o que se quer medir.
  (Filtrar `TIPOETAPA` é outra coisa — ver §5.)
- **Não converter nota para conceito na Sentença.** Não existe régua oficial; a
  conversão é decisão da escola e pertence ao middleware, onde é revisável.
- **Não trocar o `OUTER APPLY` do `SSTATUS` por `JOIN`.** Foi ele que garantiu a
  chave única.
- **Não escrever no RM por aqui.** Nota lançada à mão por professor é fonte de
  verdade; ver `docs/DECISOES.md` sobre a direção Toddle → RM.
