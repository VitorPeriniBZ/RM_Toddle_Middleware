# Especificação — Sentença `TODDLE.FREQUENCIA`

O que o middleware precisa para espelhar no Toddle a frequência que a escola já
lançou no TOTVS. O SQL está em `TODDLE.FREQUENCIA.sql`.

Escrito em 05/08/2026, com os nomes de coluna conferidos no dicionário do RM
(não inferidos). Onde algo não pôde ser verificado, está dito.

---

## 1. Para que serve, e para que NÃO serve

**Serve:** ler a frequência do RM e publicá-la no Toddle. Hoje o LMS tem **zero**
frequência nas turmas reais, e o RM tem **14.632 faltas** lançadas à mão.

**Não serve** para escrever no RM. A escrita usa
`EduFrequenciaDiariaWSData` via `wsDataServer` — ver
`docs/rm-dataservers/EduFrequenciaDiariaWSData.md`.

## 2. Cadastro

Código **exato**: `TODDLE.FREQUENCIA`. A chave é
`coligada|sistema|código` = `1|S|TODDLE.FREQUENCIA`, e o usuário do `.env`
precisa de permissão nela. Depois de publicada, o middleware a chama por
`RM_SENTENCA_FREQUENCIA` (a variável já existe no `.env`, hoje **vazia**).

Enquanto ela não responder pelo web service, não há como ler frequência por
data: o `ReadView` dos DataServers de frequência usa filtro posicional cuja
gramática não descobrimos (`Input string was not in a correct format` /
`Index was outside the bounds of the array`, 6 formas tentadas).

## 3. Parâmetros

| parâmetro | valor | por quê |
|---|---|---|
| `:CODCOLIGADA` | `1` | igual às outras Sentenças |
| `:CODPERLET` | `2026` | o ano letivo; **não** use `IDPERLET`, que é por filial |

Não parametrize campus. O middleware filtra por `RM_CODFILIAL` (fail-closed,
obrigatório sem default), e a coluna `CODFILIAL` vem no resultado para o recorte
ficar auditável.

## 4. As colunas, e por que cada uma

### Identidade — o de-para

| coluna | vira | como |
|---|---|---|
| `RA` | `studentId` | `id_mapping` `STUDENT` (253 ativos) |
| `IDTURMADISC` | `courseId` | `id_mapping` `COURSE` (185 ativos, 1:1 com `STURMADISC`) |
| `DATA` | `date` | data da aula |
| `IDHORARIOTURMA` | — | chave da aula no RM; parte da PK do `SFREQUENCIA` |

### O fato acadêmico

| coluna | observação |
|---|---|
| `PRESENCA` | **é o que queremos medir** — ver §5 |
| `JUSTIFICADA` | falta abonada |
| `IDJUSTIFICATIVAFALTA` + `JUSTIFICATIVA` | o motivo, legível |
| `JUSTIF_COMPOE_TOTAL` | `COMPOETOTALFALTAS`: se a justificativa entra no total. Decide se a falta conta para os 75% |

### Resolução do período no Toddle

| coluna | vem de | uso |
|---|---|---|
| `DIASEMANA` | `SHORARIO` | 1 = domingo no RM (o Toddle usa 1 = segunda — off-by-one medido) |
| `HORAINICIAL` / `HORAFINAL` | `SHORARIO` | a faixa |
| `CODHOR` | `SHORARIOTURMA` | formato `<dia>022<faixa>` |
| `FAIXA` | derivado | `SUBSTRING(CODHOR, 5, 3)` → `001`..`007` → `id_mapping` `PERIOD` |

**Atenção ao join:** dia e hora **não** estão em `SHORARIOTURMA`. Elas vivem em
`SHORARIO`, ligada por `CODCOLIGADA + CODHOR`. O `ReadView` do
`EduHorarioTurmaData` devolve os campos já juntados, o que engana — em SQL
puro o join é obrigatório.

### Auditoria — não é enfeite

`RECCREATEDBY`, `RECCREATEDON`, `RECMODIFIEDBY`, `RECMODIFIEDON`.

O conselho técnico de 05/08/2026 foi explícito sobre isto. Sem saber **quem**
criou a linha:

- não há como distinguir **eco da própria integração** de alteração humana;
- não há como autorizar remoção de falta, porque a regra segura é *"só remove
  automaticamente se o ledger provar que a integração criou a ausência e nenhum
  ator do RM a tocou depois"*;
- não há marca d'água confiável para o sync incremental (`RECMODIFIEDON`).

Ressalva do próprio conselho: **`RECMODIFIEDBY` não é prova de origem** depois
que passarmos a escrever com usuário técnico — todas as nossas linhas ficariam
com o mesmo autor. Serve para separar *humano* de *integração*, não para
atribuir autoria dentro de cada grupo.

## 5. O que o primeiro retorno desta Sentença resolve

O **domínio real de `PRESENCA`**. Hoje `'A'` = ausência e `'P'` = presença vêm da
documentação da TOTVS, **não de medição** — está marcado como não verificado em
todo o projeto. Esta Sentença é a primeira chance de olhar valores reais.

Isso importa muito: a semântica documentada é que `PRESENCA='P'` **remove** a
ausência. Se o domínio real for diferente (por exemplo `'S'`/`'N'`, ou nulo para
presente), a política de escrita muda inteira.

Ao receber o primeiro resultado, quero reportar:

1. **domínio de `PRESENCA`** — valores distintos e contagem de cada;
2. **linhas totais** e quantas caem nas 185 turma-disciplina em escopo;
3. **domínio de `JUSTIFICADA`** e quantas faltas são abonadas;
4. **`RECCREATEDBY` distintos** — quantos usuários lançaram, e se há usuário de
   integração no meio;
5. **faixa de datas** e se há registro fora do `IDPERLET` do campus;
6. se `(RA, IDTURMADISC, DATA, IDHORARIOTURMA)` é **único** — a PK diz que
   deveria, mas o dataset vem com `EnforceConstraints="False"`;
7. se toda linha resolve para uma `FAIXA` de `001` a `007`.

## 6. Volume esperado

Não sei, e isto é honesto: o que medi foi o **total por etapa**
(`EduNotaEtapaData`), não a contagem de linhas por data.

```
14.632 faltas somadas    7.345 no 1º trimestre + 7.287 no 2º
 5.855 combinações       (aluno, turma-disciplina, etapa) com falta > 0
```

Se `PRESENCA` só registra ausência, a ordem de grandeza é ~15 mil linhas. Se
registra presença **e** ausência, pode passar de 100 mil (253 alunos × ~2,8
aulas/dia × ~180 dias). **Rode primeiro com uma janela de datas curta** — se o
retorno vier na casa das centenas de milhares, a Sentença precisa de um
parâmetro de data antes de entrar no fluxo.

Se for o caso, o ajuste é acrescentar `:DATAINICIAL` e `:DATAFINAL` e filtrar
`F.DATA BETWEEN :DATAINICIAL AND :DATAFINAL`. Prefiro não pôr agora para não
complicar o cadastro antes de sabermos o volume.

## 7. O que NÃO fazer na Sentença

- **Sem `TOP` / `LIMIT`.** A Sentença de alunos nasceu com `SELECT TOP 30` e
  truncou o roster silenciosamente por dias — apareciam duas turmas de 185.
- **Sem filtro por `PRESENCA`.** Esconderia exatamente o que queremos medir.
- **Sem filtro por campus.** O recorte é do middleware.
- **Sem `INNER JOIN` em `SJUSTIFICATIVAFALTA`.** A maioria das faltas não tem
  justificativa; `INNER` sumiria com elas. Está `LEFT` de propósito.

## 8. Depois que ela responder

Ordem sugerida, cada passo dependendo do anterior:

1. Ler e reportar os 7 itens de §5. **Zero escrita.**
2. Só então decidir o formato do espelho no Toddle — e aí bate na parede que já
   conhecemos: `POST /public/v2/attendance` recusa com
   `"Attendance Record is not valid"` mesmo com timetable slot e `optionId`
   reais. Publicar frequência no Toddle **pode não ser possível** pela API.
3. Se não for, o valor da Sentença não se perde: ela é o insumo da reconciliação
   (saber o que o RM tem antes de aceitar qualquer coisa do Toddle) e a prova do
   domínio de `PRESENCA`, que hoje é suposição.
