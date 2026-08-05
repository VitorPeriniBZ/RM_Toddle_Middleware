# Especificação — Sentença `TODDLE.FREQ`

Leitura da frequência lançada no RM, para alimentar a via RM → Toddle. O SQL está
em `TODDLE.FREQ.sql`.

**Estado: cadastrada e VERIFICADA pelo web service em 05/08/2026.** Fevereiro/2026
devolveu 2.449 linhas, 19 colunas, PK única, sem fan-out. Falta apenas
acrescentar 4 colunas (§5).

`RM_SENTENCA_FREQUENCIA=TODDLE.FREQ` no `.env`. O código ainda não consome — a
leitura no middleware é o próximo passo.

---

## 1. Para que serve, e para que NÃO serve

**Serve:** ler frequência do RM. O Toddle tem **zero** frequência nas turmas
reais; o RM tem **21.300 ausências** lançadas à mão no ano letivo 2026.

**Não serve** para escrever no RM — isso é `EduFrequenciaDiariaWSData` via
`wsDataServer`. Ver `docs/rm-dataservers/EduFrequenciaDiariaWSData.md`.

Por que Sentença e não DataServer: o `ReadView` dos dois DataServers de frequência
usa filtro **posicional** cuja gramática não descobrimos — seis formas tentadas,
todas devolvendo `Input string was not in a correct format` ou `Index was outside
the bounds of the array`.

## 2. Parâmetros — são QUATRO

| parâmetro | exemplo | observação |
|---|---|---|
| `CODCOLIGADA` | `1` | |
| `CODPERLET` | `2026` | o ano letivo; **não** `IDPERLET`, que é por filial |
| `DATAINICIAL` | `20260201` | estilo 112, `YYYYMMDD` |
| `DATAFINAL` | `20260228` | inclusive (a Sentença usa `< DATEADD(DAY,1,...)`) |

O `testar-sentenca.sh` manda só 2 e por isso falha com *"Quantidade de parâmetros
passados para o SQL não corresponde ao esperado"*. **Não é sinal de Sentença
ausente** — a mensagem de ausência é outra (*"não existe ou não pôde ser
executada por restrição de filtro"*).

A janela obrigatória é acerto de desenho: 21.300 linhas no ano, nos dois campi.

Sem parâmetro de campus, de propósito: o middleware filtra por `RM_CODFILIAL`
(fail-closed) e a coluna `CODFILIAL` no resultado torna o recorte auditável.

## 3. O que a verificação provou

### 3.1 O domínio de `PRESENCA` — a pendência mais antiga do projeto

```
PRESENCA = "A"   em 100% das linhas   (21.300 no ano, 2.449 em fevereiro)
```

**O `SFREQUENCIA` armazena SÓ AUSÊNCIA.** Presença não é um estado gravado — é a
*ausência de linha*.

Isso era suposição vinda do PDF da TOTVS, marcada como não verificada em todo o
projeto. Agora é medição.

E torna concreto o risco central da via de volta: **`PRESENCA='P'` não "marca
presente", apaga a linha.** Com 21.300 ausências lançadas por pessoas, um
"presente" vindo do Toddle é destrutivo por desenho do RM, não por bug nosso.

### 3.2 O que passou limpo

| verificação | resultado |
|---|---|
| PK `(RA, ID_TURMADISC, DATA, ID_HORARIO_TURMA)` | **2.449 / 2.449**, zero duplicata |
| fan-out do join com `SHORARIO` | **nenhum** — o `OUTER APPLY` resolve |
| `DIASEMANA` × `DATA` | zero divergência em 8.000 linhas (CSV do ano) |
| faixa × hora no campus 2 | **1:1**, exatamente as 7 mapeadas |
| `CODPERLET` | `2026` em 100% |

### 3.3 Duas correções ao que eu havia pedido

Eu listei cinco ajustes depois de ler o CSV. **Dois não eram necessários** — eram
artefato do export, não do SQL:

| eu pedi | realidade pelo web service |
|---|---|
| converter `DATA` para ISO | já vem `2026-02-03T00:00:00` |
| pôr hora em `ALTERADO_EM` | já vem `2026-03-03T12:58:57` |

O CSV exportava `dd/MM/yyyy` e cortava a hora. O canal que o middleware usa é o
web service, e nele os dois campos já estão certos. **Nenhuma conversão é
necessária.**

### 3.4 A armadilha do `CODHOR` é pior do que eu havia registrado

Eu escrevi que o sufixo do `CODHOR` "não é global entre campi". A medição mostra
que ele **não é estável nem dentro do campus 1**:

| faixa | campus 2 | campus 1 |
|---|---|---|
| `001` | 08:00–08:20 | 08:00–08:50 **e** 08:00–09:05 |
| `002` | 08:20–09:20 | 09:15–10:05 **e** 10:05–10:55 |
| `006` | 13:50–14:50 | 13:10–14:00, 14:50–15:40 **e** 15:10–16:00 |
| `009` | — | **08:00–08:20** ← a hora da faixa `001` do campus 2 |

Consequências:

- **Campus 2:** a faixa é 1:1 com a hora. O de-para `PERIOD` atual funciona, e
  está verificado.
- **Campus 1:** o mesmo sufixo cobre até três horários. A abordagem
  "faixa → período" **não funciona** ali, e nenhuma correção de chave resolve —
  o dado não tem essa granularidade.
- Pior: a faixa `009` do campus 1 tem a mesma hora da faixa `001` do campus 2.
  Uma chave global por sufixo casaria as duas.

**Para o white-label**, a chave do período tem de ser a **hora** — o par
`(HORAINICIAL, HORAFINAL)` por campus — ou o `CODHOR` inteiro, não o sufixo. O
sufixo funcionou aqui por característica desta grade, não por regra do produto.

Isso não bloqueia o campus 2, mas precisa estar resolvido antes do segundo
cliente. Ver a nota no `id_mapping` tipo `PERIOD` (migração 007).

### 3.5 Nenhuma falta é justificada

As quatro colunas de justificativa — `JUSTIFICADA`, `ID_JUSTIFICATIVA`,
`JUSTIFICATIVA_DESCRICAO`, `COMPOE_TOTAL_FALTAS` — **nem aparecem no XML**. O
`DataSet` do .NET omite coluna nula, então ausência no XML significa NULL em todas
as linhas.

Confirmar com a coordenação: ou a escola realmente não justifica falta, ou
justifica por outro caminho que não grava nesses campos.

### 3.6 O recorte fail-closed, sobre o ano inteiro

```
total (CSV do ano)      21.300
+ CODFILIAL=2           11.057   (-10.243  campus 1)
+ turma em escopo       11.020   (-37)
+ aluno mapeado         10.179   (-841)
+ faixa 001-007         10.179   (-0)  ✓
                        ──────
PROJETÁVEIS             10.179   (47,8%)
```

172 turma-disciplina, 239 alunos, 94 datas de 03/02 a 01/07/2026.

## 4. Autoria — por que as 4 colunas que faltam importam

O conselho técnico de 05/08/2026 foi explícito: sem saber **quem** criou a linha,

- não há como distinguir eco da própria integração de alteração humana;
- não há como autorizar remoção de falta, porque a única regra segura é *"só
  remove automaticamente se houver prova de que a integração criou a ausência e
  nenhum ator do RM a tocou depois"*;
- toda remoção viraria aprovação humana — 10.179 vezes.

Ressalva do próprio conselho: **`RECMODIFIEDBY` não é prova de origem** depois que
passarmos a escrever com usuário técnico; todas as nossas linhas teriam o mesmo
autor. Serve para separar *humano* de *integração*, não para atribuir autoria
dentro de cada grupo.

## 5. O único ajuste que falta

Acrescentar 4 colunas ao `SELECT` (marcadas com `(+)` no `.sql`):

```sql
F.CODCOLIGADA     AS CODCOLIGADA,   -- está na PK do SFREQUENCIA
F.RECCREATEDBY    AS CRIADO_POR,
F.RECCREATEDON    AS CRIADO_EM,
F.RECMODIFIEDBY   AS ALTERADO_POR,
```

`ALTERADO_EM` (`RECMODIFIEDON`) já está lá e já vem com hora.

Opcional, cosmético: `FAIXA_DE_CODHORARIOTURMA` pode sair — devolve `220`,
extraído da string composta `1_3022005_1304_2__03/02/2026_11/12/2026`. Não serve
para nada e não faz mal.

## 6. O que NÃO fazer

- **Sem `TOP`/`LIMIT` no `SELECT` externo.** A Sentença de alunos nasceu com
  `SELECT TOP 30` e truncou o roster por dias. (O `TOP 1` do `OUTER APPLY` é
  outra coisa: desambigua 1 registro.)
- **Sem filtro por `PRESENCA`** — esconderia o que medimos.
- **Sem filtro por campus** — é do middleware.
- **`SJUSTIFICATIVAFALTA` fica `LEFT JOIN`.** Com `INNER`, as 21.300 linhas viram
  zero.
- **Não trocar o `OUTER APPLY` por `JOIN` em `SHORARIO`.** Foi ele que evitou o
  fan-out que a minha proposta original causaria.

## 7. Próximos passos

1. Acrescentar as 4 colunas e recadastrar.
2. Ligar a leitura no middleware, com o mesmo recorte fail-closed. **Zero
   escrita.** Reportar os `CRIADO_POR` distintos — é o que diz se a política de
   remoção é implementável.
3. Só então decidir o formato do espelho no Toddle. E aí bate na parede conhecida:
   `POST /public/v2/attendance` recusa com `"Attendance Record is not valid"`
   mesmo com timetable slot e `optionId` reais. **Publicar frequência no Toddle
   pode não ser possível pela API.**

Se não for possível, o valor da Sentença não se perde: ela é o insumo da
reconciliação — saber o que o RM tem antes de aceitar qualquer coisa do Toddle — e
foi ela que provou o domínio de `PRESENCA`.

## 8. Pendência de dado, não de código

**Nada lançado depois de 01/07/2026.** O 2º trimestre vai até 04/09 e estamos em
agosto: ou julho não foi lançado, ou o export foi cortado. Isso muda o que
"espelhar no Toddle" significa hoje.

**12 das 185 turmas em escopo não têm nenhuma falta:** `1235, 1254, 1261, 1529,
1534, 1542, 1613, 1614, 1615, 1665, 1672, 1715`. Pode ser turma sem falta, ou sem
lançamento.
