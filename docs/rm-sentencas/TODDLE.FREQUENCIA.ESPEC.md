# Especificação — Sentença `TODDLE.FREQUENCIA`

O que o middleware precisa para espelhar no Toddle a frequência que a escola já
lançou no TOTVS. O SQL está em `TODDLE.FREQUENCIA.sql`.

**Estado:** V1 cadastrada e verificada em 05/08/2026 contra 21.300 linhas reais.
A V2 do SQL corrige cinco pontos e precisa de recadastro — o diff está no topo do
arquivo `.sql`.

Nomes de coluna conferidos no dicionário do RM, não inferidos. Onde algo não pôde
ser verificado, está dito.

---

## 1. Para que serve, e para que NÃO serve

**Serve:** ler a frequência do RM. Hoje o Toddle tem **zero** frequência nas
turmas reais, e o RM tem **21.300 ausências** lançadas à mão.

**Não serve** para escrever no RM. A escrita usa `EduFrequenciaDiariaWSData` via
`wsDataServer` — ver `docs/rm-dataservers/EduFrequenciaDiariaWSData.md`.

## 2. Cadastro

Código **exato**: `TODDLE.FREQUENCIA`. Chave `1|S|TODDLE.FREQUENCIA`, com
permissão para o usuário do `.env`. O middleware a chama por
`RM_SENTENCA_FREQUENCIA`.

Por que uma Sentença e não um DataServer: o `ReadView` dos dois DataServers de
frequência usa filtro **posicional** cuja gramática não descobrimos — seis formas
tentadas, todas devolvendo `Input string was not in a correct format` ou
`Index was outside the bounds of the array`. Sem a Sentença não há leitura de
frequência por data.

## 3. Parâmetros

| parâmetro | valor | por quê |
|---|---|---|
| `:CODCOLIGADA` | `1` | igual às outras Sentenças |
| `:CODPERLET` | `2026` | o ano letivo; **não** use `IDPERLET`, que é por filial |

Sem parâmetro de campus: o middleware filtra por `RM_CODFILIAL` (fail-closed,
obrigatório sem default) e a coluna `CODFILIAL` no resultado torna o recorte
auditável.

Sem parâmetro de data: o volume medido (21.300) não exige.

## 4. O RESULTADO MEDIDO — 05/08/2026, 21.300 linhas

### 4.1 O domínio de `PRESENCA`, finalmente

```
PRESENCA = "A"   em 21.300 de 21.300 linhas   (100%)
```

**O `SFREQUENCIA` armazena SÓ AUSÊNCIA.** Presença não é um estado gravado — é a
*ausência de linha*.

Isso encerra a pendência mais antiga do projeto: `'A'`/`'P'` vinha da
documentação da TOTVS e estava marcado como não verificado em todo lugar. Agora é
medição.

E torna concreto o risco central da via de volta: **`PRESENCA='P'` não "marca
presente", apaga a linha.** Com 21.300 ausências lançadas por pessoas, um
"presente" vindo do Toddle é destrutivo por construção — não por bug, por
desenho do RM.

### 4.2 O que passou limpo

| verificação | resultado |
|---|---|
| PK `(RA, IDTURMADISC, DATA, IDHORARIOTURMA)` única | **21.300 / 21.300**, zero duplicatas |
| `DIASEMANA` confere com a `DATA` | **zero** divergências em 8.000 linhas |
| faixas de hora do campus 2 | exatamente as **7** que mapeamos |
| `CODPERLET` | `2026` em 100% |

As 7 faixas do campus 2, com volume:

```
08:00-08:20  3.221     10:40-11:40  1.180     14:50-15:50  1.559
08:20-09:20  1.313     11:40-12:40  1.218
09:20-10:20  1.207     13:50-14:50  1.359
```

### 4.3 O recorte fail-closed, passo a passo

```
total no CSV            21.300
+ CODFILIAL=2           11.057   (-10.243  campus 1)
+ turma em escopo       11.020   (-37)
+ aluno mapeado         10.179   (-841)
+ faixa 001-007         10.179   (-0)  ✓
                        ──────
PROJETÁVEIS             10.179   (47,8%)
```

172 turma-disciplina, 239 alunos, 94 datas de 03/02 a 01/07/2026.

### 4.4 ARMADILHA: o sufixo do `CODHOR` não é global

As faixas `008`–`013` são **100% do campus 1** — nenhuma contaminação. Mas o
inverso não vale: as faixas `001`–`007` **também existem no campus 1, com horas
diferentes**.

| faixa | campus 2 | campus 1 |
|---|---|---|
| `001` | 08:00–08:20 | 08:00–08:50 |

O `id_mapping` `PERIOD` hoje usa `rm_code = '001'` **sem campus**. Enquanto só o
campus 2 está em escopo, é inofensivo. No dia em que o campus 1 entrar — e para
um produto white-label isso é o caso normal, não a exceção — a faixa `001`
resolveria para o período errado, silenciosamente.

**Correção necessária antes do segundo campus:** chavear o `PERIOD` por
`<campus>:<faixa>`, ou fazer o `target_instance_key` distinguir campus.

## 5. As colunas

### Identidade — o de-para

| coluna | vira | como |
|---|---|---|
| `RA` | `studentId` | `id_mapping` `STUDENT` |
| `ID_TURMADISC` | `courseId` | `id_mapping` `COURSE` |
| `DATA` | `date` | **ISO** na V2 (era `dd/MM/yyyy`) |
| `ID_HORARIO_TURMA` | — | parte da PK do `SFREQUENCIA` |
| `CODCOLIGADA` | — | novo na V2; está na PK |

### O fato acadêmico

`PRESENCA`, `JUSTIFICADA`, `ID_JUSTIFICATIVA`, `JUSTIFICATIVA_DESCRICAO`,
`COMPOE_TOTAL_FALTAS`.

### Resolução do período

`CODHOR`, `FAIXA_DE_CODHOR` (`SUBSTRING(CODHOR, 5, 3)`), `DIASEMANA`,
`HORAINICIAL`, `HORAFINAL`, `NUMERO_AULA`, `CODTURNO`.

**Atenção ao join:** dia e hora **não** estão em `SHORARIOTURMA` — vivem em
`SHORARIO`, ligada por `CODCOLIGADA + CODHOR`. O `ReadView` do
`EduHorarioTurmaData` devolve tudo já juntado, o que engana; em SQL puro o join é
obrigatório.

### Auditoria — o que sustenta a política de remoção

`CRIADO_POR` (`RECCREATEDBY`), `CRIADO_EM`, `ALTERADO_POR` (`RECMODIFIEDBY`),
`ALTERADO_EM` (`RECMODIFIEDON`, **com hora** na V2).

O conselho técnico de 05/08/2026 foi explícito: sem saber **quem** criou a linha,

- não há como distinguir eco da própria integração de alteração humana;
- não há como autorizar remoção de falta, porque a única regra segura é *"só
  remove automaticamente se o ledger provar que a integração criou a ausência e
  nenhum ator do RM a tocou depois"*;
- não há marca d'água confiável para o sync incremental.

Sem `CRIADO_POR`, toda remoção precisaria de aprovação humana — 10.179 vezes.

Ressalva do próprio conselho: **`RECMODIFIEDBY` não é prova de origem** depois
que passarmos a escrever com usuário técnico; todas as nossas linhas teriam o
mesmo autor. Serve para separar *humano* de *integração*, não para atribuir
autoria dentro de cada grupo.

`ALTERADO_EM` com granularidade de **dia** (como veio na V1) forçaria reprocessar
o dia inteiro a cada ciclo — daí a hora na V2.

## 6. Duas coisas para confirmar com a escola

**`JUSTIFICADA` está vazio em 100%** das 21.300 linhas, e nenhuma justificativa
aparece. Como `JUSTIFICADA` vem da própria `SFREQUENCIA` e não do `LEFT JOIN`, a
leitura provável é que **nenhuma falta é justificada** nesta escola. Se a
coordenação disser que justifica, então algo não está sendo gravado.

**Nada depois de 01/07/2026.** O 2º trimestre vai até 04/09 e estamos em agosto:
ou julho não foi lançado, ou o export foi cortado. Isso muda o que "espelhar no
Toddle" significa hoje.

Menor: **12 das 185 turmas não têm nenhuma falta** — `1235, 1254, 1261, 1529,
1534, 1542, 1613, 1614, 1615, 1665, 1672, 1715`. Pode ser turma sem falta, ou
sem lançamento.

## 7. O que NÃO fazer na Sentença

- **Sem `TOP` / `LIMIT`.** A de alunos nasceu com `SELECT TOP 30` e truncou o
  roster por dias — apareciam 2 turmas de 185.
- **Sem filtro por `PRESENCA`.** Esconderia o que queremos medir.
- **Sem filtro por campus.** O recorte é do middleware.
- **`SJUSTIFICATIVAFALTA` fica `LEFT JOIN`.** Com `INNER`, as 21.300 linhas
  viram zero — nenhuma tem justificativa.

## 8. Depois que a V2 responder

1. Ligar a leitura no middleware, com o mesmo recorte fail-closed. **Zero
   escrita.**
2. Reportar `CRIADO_POR` distintos — é o que diz se existe usuário de integração
   no meio e se a política de remoção é implementável.
3. Só então decidir o formato do espelho no Toddle. E aí bate na parede
   conhecida: `POST /public/v2/attendance` recusa com
   `"Attendance Record is not valid"` mesmo com timetable slot e `optionId`
   reais. **Publicar frequência no Toddle pode não ser possível pela API.**

Se não for, o valor da Sentença não se perde: ela é o insumo da reconciliação
(saber o que o RM tem antes de aceitar qualquer coisa do Toddle) e foi ela que
provou o domínio de `PRESENCA`.
