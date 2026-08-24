# Especificação — Sentença `TODDLE.PLANOAULA`

> **Estado: A CADASTRAR, e o fluxo que ela serve está BLOQUEADO por terceiro.**
> Escrita em 21/08/2026, colunas conferidas uma a uma no dicionário do RM (51
> referências, zero ausentes) e chaves de JOIN tiradas da `GLINKSREL` — mas
> **não executada**. Ver §7 antes de investir tempo nela.

## 1. Para que serve

Ler o plano de aula do RM **com autoria**, para tornar verificável a regra que
protege o trabalho dos professores.

O destino da escrita é o DataServer `EduPlanoAulaData` (ver
`docs/rm-dataservers/EduPlanoAulaData.md`). Ele escreve em `SPLANOAULA` — mas o
schema dele **não expõe** `RECCREATEDBY` / `RECMODIFIEDBY`, embora as colunas
existam na tabela. Sem elas não há como saber se um conteúdo foi escrito por um
humano ou pela integração, e a regra abaixo seria impossível de aplicar:

> Escreva `CONTEUDOEFETIVO` apenas quando ele estiver **vazio**, ou quando a
> última escrita dele tiver sido da própria integração. Campo preenchido por
> humano e nunca tocado por nós é **intocável** — gera pendência de revisão, não
> sobrescrita.

Essa regra não é zelo excessivo: medido em 21/08/2026, **12.166 das 22.367**
linhas de plano de aula do campus 2 já têm conteúdo escrito à mão por professores.

É o mesmo papel que a `TODDLE.FREQ` cumpre para frequência, e pelo mesmo motivo —
lá também é o `CRIADO_POR` que sustenta a política de remoção de falta.

## 2. Parâmetros — são QUATRO

| parâmetro | tipo | exemplo | observação |
|---|---|---|---|
| `CODCOLIGADA` | Inteiro | `1` | |
| `CODPERLET` | **Texto** | `2026` | a coluna é alfanumérica |
| `DATAINICIAL` | Inteiro/Texto | `20260201` | estilo 112 (`YYYYMMDD`) |
| `DATAFINAL` | Inteiro/Texto | `20260228` | idem, inclusivo |

**A janela de datas é obrigatória, e isso é bom.** São 22.367 linhas no ano
letivo só no campus 2 — o ano inteiro em um XML passaria de 25 MB, contra ~3 MB
que os 2.455 registros de fevereiro da `TODDLE.FREQ` já produzem. Mesma decisão,
mesmo motivo.

O `< DATEADD(DAY, 1, ...)` no fim da janela, em vez de `<=`, existe para o caso
de `DATA` passar a carregar hora: hoje vem `00:00`, e um `<=` silenciosamente
perderia o último dia se isso mudar.

Parâmetro é `:NOME`. O TOTVS **recusa** `@NOME` — ver o README desta pasta.

## 3. Tabelas e chaves — da `GLINKSREL`, não de memória

| tabela | papel |
|---|---|
| `SPLANOAULA` | o plano de aula. 30 colunas |
| `STURMADISC` | turma, disciplina, campus, `IDPERLET` |
| `SPLETIVO` | traduz `CODPERLET` ↔ `IDPERLET` |
| `SDISCIPLINA` | nome da disciplina |
| `SPROFESSOR` → `PPESSOA` | professor alocado à aula |
| `SHORARIO` | dia da semana e horário — ver o aviso abaixo |

`SPLANOAULA → STURMADISC` tem link **real** na `GLINKSREL`
(`CODCOLIGADA + IDTURMADISC`), diferente da `TODDLE.NOTAS`, onde o link não existe
e o par foi inferido.

> ⚠️ **`SPLANOAULA → SHORARIO` só casa por `CODHOR`** — sem período letivo. É
> exatamente a armadilha de fan-out que a `TODDLE.FREQ` documenta: o mesmo
> `CODHOR` existe em mais de um período letivo, e um `JOIN` multiplicaria a linha.
> Por isso o `OUTER APPLY ... TOP 1` preferindo o `IDPERLET` da turma, e não um
> `JOIN`. **Não troque por `JOIN`.**

`SPLANOAULA` **não tem** `CODTURMA` nem `CODDISC` — quem os mostra é o
DataServer, que junta por baixo. Aqui eles vêm de `STURMADISC` explicitamente.

## 4. Os apelidos são contrato — e dois deles são deliberados

| coluna | origem | por que este nome |
|---|---|---|
| **`CONTEUDO_PREVISTO`** | `SPLANOAULA.CONTEUDO` | é a **ementa**, da coordenação. **NUNCA escrever.** |
| **`CONTEUDO_MINISTRADO`** | `SPLANOAULA.CONTEUDOEFETIVO` | é o que o professor lança. **É o destino.** |

Os nomes crus do RM (`CONTEUDO` e `CONTEUDOEFETIVO`) são fáceis de trocar por
descuido, e trocar significa sobrescrever a ementa da escola com registro de
aula. A confusão "previsto × ministrado" foi exatamente a que a decisão **D6**
teve de resolver — então o contrato a resolve no nome, não em comentário.

| apelido | origem |
|---|---|
| `CODCOLIGADA`, `ID_TURMADISC`, `ID_PLANOAULA` | chave da linha |
| `ID_HORARIO_TURMA` | `IDHORARIOTURMA` — a aula na grade |
| `NUMERO_AULA` | `AULA` |
| `DATA`, `DATA_EFETIVA`, `REPOSICAO` | data prevista, de reposição, e o flag |
| `LICAO_CASA`, `OBSERVACAO` | outros campos do professor |
| `CONFIRMADO`, `TIPO_AULA`, `FREQ_DISP_WEB` | flags — ver §6 |
| `COD_TURMA`, `CODDISC`, `NOME_DISCIPLINA`, `CODFILIAL`, `TURMADISC_ATIVA` | contexto |
| `CODPROF`, `NOME_PROFESSOR`, `SUBSTITUTO` | professor alocado |
| `DIASEMANA`, `HORAINICIAL`, `HORAFINAL` | da grade, via `OUTER APPLY` |
| **`CRIADO_POR`, `CRIADO_EM`, `ALTERADO_POR`, `ALTERADO_EM`** | **a razão de existir desta Sentença** |
| `CODPERLET`, `PERIODO_LETIVO` | período letivo |

## 5. Não filtre — devolva os flags

Sem filtro de campus: o recorte é do middleware (`RM_CODFILIAL`, fail-closed), e
`CODFILIAL` vem no SELECT para ser auditável. Mesma simetria das outras quatro.

Sem filtro por `CONTEUDO_MINISTRADO` vazio ou preenchido: é justamente a
comparação que o consumidor precisa fazer. Filtrar aqui esconderia metade da
decisão.

**Sem `TOP` nem `LIMIT`.** A Sentença de alunos nasceu com `SELECT TOP 30` e
truncou o roster em silêncio. (O `TOP 1` do `OUTER APPLY` é outra coisa:
desambigua um registro, não recorta o resultado.)

## 6. O que já foi MEDIDO — via DataServer, não por esta Sentença

`ReadView` de `EduPlanoAulaData` sobre o campus 2, em 21/08/2026:

| medida | valor |
|---|---|
| linhas | 22.367 |
| `CONTEUDO` (previsto) preenchido | 6.365 |
| **`CONTEUDOEFETIVO` (ministrado) preenchido** | **12.166** |
| `LICAOCASA` | 58 |
| `CONFIRMADO` | `'N'` em **100%** |
| janela de `DATA` | 2025-09-01 a 2026-12-31 |
| chave `(IDTURMADISC, IDPLANOAULA)` | 22.367 distintas / 22.367 linhas |
| turma-disciplina distintas | 202 — as do período letivo corrente |

Três coisas que isso decide:

1. **As linhas são pré-criadas pela grade.** Escrever é `UPDATE`, nunca `INSERT`.
   Não criamos aula; preenchemos aula que já existe.
2. **A chave é única** — nenhum fan-out no caminho `SPLANOAULA`.
3. **`CONFIRMADO = 'N'` em 100%** merece uma pergunta antes da primeira escrita:
   se `'S'` fecha a aula para edição, é a guarda natural de "não mexer em aula
   fechada" — o análogo da etapa liberada para nota. Hoje ninguém confirma.

O que **não** se pode afirmar: que esta Sentença devolve isso. Ela não rodou. Na
primeira execução, confira que a contagem de uma janela bate com o `ReadView` do
mesmo período e que a chave `(ID_TURMADISC, ID_PLANOAULA)` não duplicou — se
duplicar, o suspeito é o `OUTER APPLY` ter virado `JOIN`.

```bash
./docs/rm-sentencas/testar-sentenca.sh TODDLE.PLANOAULA
```

> ⚠️ O `testar-sentenca.sh` manda só `CODCOLIGADA` e `CODPERLET`. Esta Sentença
> precisa de quatro, então o script vai devolver *"Quantidade de parâmetros
> passados para o SQL não corresponde ao esperado"* — o que, por sinal, é a
> confirmação de que ela **existe** no RM. Para executar de verdade, passe a
> janela como a `TODDLE.FREQ` exige.

## 7. ⛔ Por que ela existe agora, se o fluxo está bloqueado

Sejamos claros: **o fluxo de plano de aula não pode rodar hoje.** A Open API V2
do Toddle **não expõe plano de aula** — nem nos 151 endpoints documentados, nem
no servidor real (`unit-plans`, `lesson-plans`, `units`, `lessons`, `planner`,
`curriculum-units` e as variantes aninhadas em `/teacher-courses/:id/` devolvem
todas `"Route Not Found"`). Sem leitura na origem, não há o que escrever.

Então por que escrever a Sentença agora?

Porque **cadastrar Sentença no RM tem prazo de terceiro** — depende de quem
administra o TOTVS —, e isso já custou caro neste projeto: a `TODDLE.TURMADISC`
ficou meses como "sem ela não há sincronização possível". Se o Toddle responder
que expõe plano de aula (por solicitação, outro tier, ou roadmap), a Sentença
estar pronta e cadastrada é a diferença entre começar no mesmo dia e esperar mais
uma rodada de pedido interno.

E ela tem valor **independente do Toddle**: com ela dá para responder hoje
quantas aulas têm conteúdo, quem lançou e quando — que é o dado de base para
conversar com a coordenação sobre a adoção.

**Não construa o writer antes de o Toddle responder.** Ver `DECISOES.md` D6,
item 3.
