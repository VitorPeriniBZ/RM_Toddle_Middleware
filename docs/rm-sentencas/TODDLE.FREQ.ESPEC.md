# Especificação — Sentença `TODDLE.FREQ`

Leitura da frequência lançada no RM, para alimentar a via RM → Toddle. O SQL está
em `TODDLE.FREQ.sql`.

**Estado: cadastrada, completa e VERIFICADA pelo web service em 05/08/2026.**
Fevereiro/2026 devolveu 2.449 linhas, **23 colunas**, PK única, sem fan-out.
Nenhum ajuste pendente.

`RM_SENTENCA_FREQUENCIA=TODDLE.FREQ` no `.env`. **A leitura está ligada** em
`packages/domain/src/rmAttendanceSource.ts`, exercitada por
`npm run ler:frequencia -- --de YYYY-MM-DD --ate YYYY-MM-DD`.

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

### 3.6 As 4 colunas de autoria chegaram — e o que elas dizem

Verificado em 05/08/2026, fevereiro/2026, 23 colunas, 2.449 linhas.

**Toda falta é humana. Nenhuma foi alterada depois de criada.**

```
criada e nunca alterada:  2.449 de 2.449   (CRIADO_EM == ALTERADO_EM)
alterada depois:              0
autores distintos:           45
```

Os 45 autores: **41 no formato CPF** (11 dígitos) e 4 com login nominal
(`gean.taufner`, `jessica.silva`, `patricia.freitas`, `professor.eav`). O usuário
de integração do `.env` **não aparece** entre eles — coerente, porque nunca
escrevemos frequência.

**A política de remoção é implementável, e o veredito dela hoje é "bloqueie
tudo".** A regra do conselho é *"só remove automaticamente se a integração criou a
ausência e nenhum ator do RM a tocou depois"*. Como 100% foi criada por pessoas,
nenhuma das 10.179 ausências em escopo pode ser removida automaticamente. Isso não
é limitação do desenho — é o desenho funcionando: o que existe hoje é registro
humano e fica protegido.

#### CPF é dado pessoal — não persistir

`CRIADO_POR` traz **CPF de professor**. Sob a LGPD isso é dado pessoal, e o
middleware não precisa dele: para a política, basta saber *se o autor é a nossa
integração ou não* — um booleano.

**Regra para a implementação:** ao ler, derivar
`criado_pela_integracao = (CRIADO_POR == RM_WS_USER)` e **descartar o valor
original**. Se for necessário rastrear disputa, guardar um hash com sal por
tenant, nunca o CPF. E nunca logar `CRIADO_POR` — o logger é `pino` com saída em
JSON, e log vaza para onde ninguém revisou.

Isso vale em dobro para o white-label: cada escola nova traz os CPFs do seu corpo
docente.

#### O lançamento é retroativo, e isso decide a marca d'água

As faltas de **fevereiro** foram criadas entre **03/03 e 29/05** — de um a três
meses depois da aula.

Consequência direta: **a marca d'água do sync incremental tem de ser
`ALTERADO_EM`, nunca `DATA`.** Um sync que avança por data da aula perderia todo
lançamento retroativo — e retroativo é a regra aqui, não a exceção.

Também afeta o produto: se espelharmos no Toddle, as faltas vão aparecer semanas
depois da aula. Isso é característica do processo da escola, não atraso da
integração, e vale dizer a quem for usar.

#### `professor.eav` é conta genérica

4 linhas foram criadas por `professor.eav`. Um login compartilhado quebra a
auditoria: não dá para saber qual professor lançou. São poucas linhas, mas se essa
conta for usada de forma ampla no futuro, a política de autoria perde precisão.
Vale a coordenação saber.

### 3.7 O recorte fail-closed, sobre o ano inteiro

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

## 4. Autoria — por que essas colunas importam

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

## 5. Ajustes — CONCLUÍDOS

As 4 colunas foram acrescentadas e verificadas em 05/08/2026: `CODCOLIGADA`,
`CRIADO_POR`, `CRIADO_EM`, `ALTERADO_POR`. A Sentença devolve **23 colunas** e
está completa para o middleware.

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

1. ~~Acrescentar as 4 colunas e recadastrar.~~ **Feito e verificado.**
2. Ligar a leitura no middleware, com o mesmo recorte fail-closed. **Zero
   escrita.** Derivar `criado_pela_integracao` e **descartar o CPF** (§3.7).
3. ~~Decidir o formato do espelho no Toddle.~~ **SUPERADO pela decisão D1 de
   06/08/2026** (ver `docs/DECISOES.md`): a direção é Toddle → RM, não o contrário.
   Os professores passam a lançar no Toddle, e o RM é o destino.

   Consequência para esta Sentença: ela **não** alimenta mais um espelho. O papel
   dela agora é **reconciliação** — saber o que o RM já tem antes de aceitar
   qualquer coisa do Toddle, e não sobrescrever as 21.300 ausências humanas. Isso
   ficou mais importante, não menos.

   E foi ela que provou o domínio de `PRESENCA` — o insumo que torna a escrita
   possível.

## 8. Os 880 recusados por aluno — investigado, NÃO é lacuna nossa

Corrijo o que eu havia escrito. Ao ligar a leitura, 880 faltas (7%) foram
recusadas por `ALUNO_NAO_MAPEADO` e eu chamei isso de *"lacuna nossa, não do
RM"*. **Errado.** Investigado em 05/08/2026:

Os 11 RAs são **ex-alunos**:

| status | quantos |
|---|---|
| Transferido | 9 |
| Cancelado - Rematrícula | 2 |

Todos com `STATUS_ATIVO=N`. As faltas são de quando estavam matriculados — dado
histórico legítimo. Não estarem mapeados é **correto**, e recusar as 880 é o
comportamento certo, não um defeito.

Mais amplo: dos **40** alunos que a Sentença de alunos devolve e não têm
mapeamento, **zero estão ativos**:

```
N | Cancelado - Rematrícula   28
N | Transferido               10
N | Cancelado - Matrícula      1
N | Reopção de Turma           1
────────────────────────────────
ATIVOS sem mapeamento:          0
```

O sync de alunos está **completo e correto**: os 253 mapeados são todos os alunos
ativos do campus 2.

**Limitação de produto que decorre disso:** a falta de um aluno que saiu não pode
ser espelhada no Toddle, porque o aluno (corretamente) não está lá. Se algum dia a
escola quiser histórico completo no LMS, isso exige decidir o que fazer com
ex-alunos — e a API do Toddle não devolve arquivado em nenhum GET.

### 8.1 O caso A+G existe: 6 alunos com linha ativa E inativa

Era pergunta aberta no projeto — *"não implemente desempate de turma antes de
confirmar se o caso existe de fato"*. **Existe.** A Sentença de alunos devolve 586
linhas para 579 RAs, e **6 RAs têm simultaneamente uma linha ativa e uma
inativa**:

```
202600085: EAVHS10IA/S + EAVHS11IA/N   (Cancelado - Matrícula)
202600129: EAVMS06IB/S + EAVMS07IB/N   (Reopção de Turma)
202600009: EAVES02IA/N + EAVES03IB/S
202600122: EAVES05IB/N + EAVMS06IB/S
202600039: EAVPS01MA/N + EAVPS01IA/S
202400095: EAVPS03MA/S + EAVPS03IB/N
```

É troca de turma: a matrícula antiga fica cancelada e uma nova é criada. **O aluno
está ativo.**

Uma regra "tem linha inativa → arquiva" arquivaria 6 alunos ativos. O
`studentSync.processor.ts` já faz o desempate certo (*"contexto ativo tem
prioridade"*, linha 71) — mas agora sabemos que esse código é exercitado de fato,
não é defensivo teórico.

**Cuidado para quem escrever consulta nova:** um `new Map(rows.map(r => [r.RA, r]))`
guarda a ÚLTIMA linha, que pode ser a inativa. Foi o que aconteceu num script meu
de análise, e me fez concluir por um instante que 2 alunos ativos deveriam ser
arquivados. O desempate tem de ser explícito: **se qualquer linha está ativa, o
aluno está ativo.**

### 8.2 Os 60 recusados por turma: `IDTURMADISC 1714` — lacuna REAL, e uma só

Investigado em 05/08/2026. Diferente dos 880, este **é** um furo nosso.

`1714` = `EAVHS10IA` / `MSHS26ELA` — **"ELA Higher Level"**, campus 2,
`IDPERLET 15`, `ATIVA='S'`. Turma-disciplina legítima, de uma turma que está em
escopo, com 60 faltas em 20 datas (14/04 a 10/07) e 10 alunos, **9 deles já
mapeados**. Não há mapeamento `COURSE` para ela, nem ativo nem arquivado.

Medindo a extensão:

```
turma-disciplina ativas do IDPERLET 15 no campus 2:  202
mapeadas (COURSE ativo):                             185
SEM mapeamento nenhum:                                17
```

Mas as 17 não são todas iguais:

| | quantas | alunos | impacto |
|---|---|---|---|
| turmas com sufixo **`IG`** (`EAVHS10IG`, `EAVMS06IG`, `07IG`, `08IG`) | 16 | **0** | nenhum |
| **`1714`** (`EAVHS10IA` / ELA Higher Level) | 1 | 10 | **60 faltas** |

As turmas `IG` não têm um único aluno matriculado — são oferta criada no RM e
nunca enturmada. Ficarem fora é irrelevante hoje, e o `id_mapping` não deve
inventá-las.

Também conferido, e limpo:

```
ativas no RM mas arquivadas no de-para:   0
mapeadas e inativas no RM:                0
```

#### A causa estrutural: não existe sync de turma

O `.env` tem `RM_SENTENCA_STUDENTS`, `RM_SENTENCA_FREQUENCIA` e
`RM_SENTENCA_NOTAS`. **Não existe `RM_SENTENCA_TURMADISC`.**

Os 185 `COURSE` vieram de uma carga manual (o CSV de 03/08/2026), e **nada os
atualiza**. Então o de-para de turma é um retrato, não uma sincronização: toda
turma-disciplina que a escola criar depois fica invisível para a integração, e só
aparece por acidente — como esta apareceu, ao cruzar frequência.

Não descobri por que `1714` especificamente ficou fora daquela carga: as faltas
dela começam em 14/04 e o export é de 03/08, então ela existia. Ou o CSV foi
filtrado, ou houve falha na criação daquela turma no Toddle. Sem o CSV original
não dá para afirmar, e não vou chutar.

**Recomendação:** cadastrar a Sentença de turma-disciplina (já especificada em
`TODDLE.TURMADISC.ESPEC.md`) e ligar um relatório de reconciliação que compare o
RM com o `id_mapping`. O objetivo não é criar turma automaticamente — é a **deriva
ser detectada em vez de descoberta**.

## 9. Pendência de dado, não de código

**Nada lançado depois de 01/07/2026.** O 2º trimestre vai até 04/09 e estamos em
agosto: ou julho não foi lançado, ou o export foi cortado. Isso muda o que
"espelhar no Toddle" significa hoje.

**12 das 185 turmas em escopo não têm nenhuma falta:** `1235, 1254, 1261, 1529,
1534, 1542, 1613, 1614, 1615, 1665, 1672, 1715`. Pode ser turma sem falta, ou sem
lançamento.
