# Responsáveis — Sentença `TODDLE.RESP`

**Estado: cadastrada e VERIFICADA em 05/08/2026.** 845 linhas, 12 colunas, uma
linha por aluno. Os 253 alunos em escopo têm **responsável acadêmico E financeiro**,
com parentesco e ID.

`RM_SENTENCA_RESPONSAVEIS` ainda não existe no `.env` — entra quando a leitura for
implementada.

---

## 1. Duas correções minhas, na ordem em que erramos

**Primeira versão devolveu zero.** Eu escrevi o SQL sobre `SALUNORESPONSAVEL`, e
essa tabela está **vazia** nesta instalação — confirmado também pelos atalhos
`CODPESSOARACA`/`CODPARENTRACA`/`CODPARENTCFO`/`CODCFO`, nulos em 30/30 alunos. A
Sentença executava sem fault e sem erro de permissão; simplesmente não casava nada.

**Depois eu disse que não precisava de Sentença**, porque o `EduAlunoData` resolve
`RESPACADEMICO`/`EMAILRESPACADEMICO` na própria view. Verdade, mas **incompleto**:
aquele caminho não dá ID nem parentesco.

A versão cadastrada resolve as duas coisas. Ela usa o caminho acadêmico
(`CODPESSOA`) e o financeiro (`CODCFO`), que é onde esta escola de fato guarda o
dado.

## 2. O que a Sentença devolve

12 colunas, uma linha por aluno:

```
RA, ALUNO
COD_RESP_ACADEMICO, RESP_ACADEMICO, EMAIL_ACADEMICO, EMAIL_ACAD_PESSOAL,
    PARENTESCO_ACADEMICO
COLIGADA_CFO, COD_RESP_FINANCEIRO, RESP_FINANCEIRO, EMAIL_FINANCEIRO,
    PARENTESCO_FINANCEIRO
```

Parâmetros: `CODCOLIGADA` e `CODPERLET`. Sem filtro de campus — o middleware
recorta por `RM_CODFILIAL`; das 845 linhas, **253 caem no escopo** e 592 são de
outros campi.

## 3. O RESULTADO MEDIDO

### 3.1 Cobertura — não há aluno descoberto

```
alunos em escopo com AMBOS (acadêmico e financeiro):  253 de 253
alunos SEM nenhum responsável:                          0
linhas por aluno:                                        1
```

E-mail:

```
EMAIL_ACADEMICO      251/253
EMAIL_FINANCEIRO     250/253
EMAIL_ACAD_PESSOAL   234/253   (fallback)
```

**O gargalo que eu previa não existe.** Eu havia marcado o e-mail obrigatório do
`POST /parents` como o risco, citando os 5 professores que ficaram sem e-mail. Aqui
faltam 2 acadêmicos e 3 financeiros — e nenhum aluno fica sem alguém alcançável.

### 3.2 Parentesco — a Sentença dá o que o DataServer não dava

| acadêmico | | financeiro | |
|---|---|---|---|
| Mãe | 190 | Pai | 162 |
| Pai | 45 | Mãe | 71 |
| (vazio) | 10 | Outros | 12 |
| Enteado(a) | 4 | (vazio) | 5 |
| Outros | 4 | Avô(ó) | 3 |

Isso alimenta `relationships[{childId, relationship}]` de verdade, em vez de só
*"acadêmico"/"financeiro"*.

Duas observações: **10 + 5 vazios** (mapear para "Outros" ou deixar sem
`relationship`, que é opcional), e **4 "Enteado(a)"** no acadêmico — parentesco do
aluno em relação ao responsável, invertido. Não muda nada técnico; muda o texto que
aparece na tela do Toddle.

### 3.3 Pessoas distintas, e as duas chaves

```
acadêmicos distintos (COD_RESP_ACADEMICO = CODPESSOA):  220
financeiros distintos (COLIGADA_CFO:COD_RESP_FINANCEIRO = CODCFO):  213
sem e-mail: 2 acadêmicos, 3 financeiros
```

**Os dois IDs vivem em espaços diferentes** — `CODPESSOA` e `CODCFO` não são
comparáveis. A mesma pessoa como responsável acadêmico e financeiro tem dois
códigos distintos, e nada no retorno os liga. Por isso a consolidação tem de ser
pelo **e-mail**.

### 3.4 O que o Toddle receberia

```
parents distintos (chave = e-mail):  395

filhos por parent:
   1 filho    332
   2 filhos    60
   3 filhos     2
   8 filhos     1   ← ver §4.2
```

## 4. Três decisões da escola, antes de qualquer escrita

### 4.1 Cinco e-mails pertencem a pessoas diferentes

```
ta***@gmail.com        Luiz / Tatiana
al***@hotmail.com.br   Alexandra / Eduardo
tk***@hotmail.com      Kesia / Raphael
dr***@gmail.com        Adriana / Alexsandro
le***@gmail.com        Alexandre / Richardeny
```

Parecem casais com um endereço só. No Toddle o e-mail é a identidade, então **só um
dos dois pode existir**. Escolher por regra (o acadêmico, por exemplo) ou pedir
e-mail separado. Não é decisão de implementação.

### 4.2 Um e-mail ligado a 8 alunos

Pode ser família grande, mas vale conferir se não é endereço institucional. Se for,
criar esse parent dá a uma pessoa acesso ao dado de 8 crianças.

### 4.3 Criar parent é dar acesso ao LMS

Responsável no Toddle vê nota, frequência e comunicado do filho. Criar 395 contas
não é sincronizar dado, é **dar acesso a pessoas** — e §4.1 e §4.2 são exatamente
onde isso pode ir para a pessoa errada.

Precisa de decisão explícita sobre quem entra, e provavelmente de comunicação
antes.

## 5. Limitações conhecidas do dado

- **A chave do de-para é o e-mail**, não um ID. `CODPESSOA` e `CODCFO` não se
  conversam, então não há identificador único de pessoa. Se a escola trocar o
  e-mail de um responsável, ele viraria um parent novo. Mitigação: guardar o e-mail
  **e** um hash do nome normalizado, para detectar troca em vez de duplicar.
- **Só dois responsáveis por aluno.** Se houver um terceiro, ele não aparece — e não
  temos como saber que existe.
- **`PPESSOA` traz CPF.** A Sentença não o expõe, e não deve passar a expor: mesma
  regra da frequência, dado pessoal não persiste no middleware nem entra em log.

## 6. Ordem sugerida

1. Implementar a leitura no middleware, agrupando por e-mail, de-para em
   `id_mapping` tipo `PARENT` (que já existe). **Zero escrita.**
2. Levar §4.1, §4.2 e §4.3 para a escola.
3. Só então `POST /parents`, em ensaio primeiro.

---

## Anexo — o SQL sobre `SALUNORESPONSAVEL`, que não serve hoje

**Corrigido em 20/08/2026.** Até esta data, `TODDLE.RESP.sql` no repositório era a
primeira versão, sobre `SALUNORESPONSAVEL` — a que **devolve zero nesta
instalação**. Quem colasse aquele arquivo no RM cadastraria uma Sentença que
executa sem erro e não casa nada. Pior: os apelidos dela (`NOME_COMPLETO`,
`EMAIL`, `PARENTESCO`) **não são os que `rmGuardianSource.ts` lê**
(`RESP_ACADEMICO`, `EMAIL_ACADEMICO`, `PARENTESCO_ACADEMICO`), então o
middleware descartaria linha por linha mesmo se houvesse dado.

`TODDLE.RESP.sql` agora é a **versão cadastrada e validada** — as 12 colunas da §2,
pelo caminho `SALUNO.CODPESSOARACA` (acadêmico) e `SALUNO.CODCOLCFO + CODCFO`
(financeiro). Reconstruída a partir desta especificação, conferida no dicionário e
**executada com sucesso em 20/08/2026** (ver o bloco de validação no fim).

A versão morta fica preservada aqui: se a escola passar a popular
`SALUNORESPONSAVEL`, ela é o caminho melhor, porque dá vários responsáveis por
aluno, ID estável (`CODPESSOA`) e `STATUS` do vínculo.

```sql
SELECT R.CODCOLIGADA                     AS CODCOLIGADA,
       R.RA                              AS RA,
       R.CODPESSOA                       AS COD_PESSOA,
       P.NOME                            AS NOME_COMPLETO,

       P.EMAIL                           AS EMAIL,
       P.EMAILPESSOAL                    AS EMAIL_PESSOAL,

       P.SEXO                            AS SEXO,
       P.TELEFONE1                       AS TELEFONE1,
       P.TELEFONE2                       AS TELEFONE2,

       R.CODTIPORESP                     AS COD_TIPO_RESP,
       TR.DESCRICAO                      AS TIPO_RESP,
       R.CODPARENTESCO                    AS COD_PARENTESCO,
       PA.DESCRICAO                      AS PARENTESCO,

       R.STATUS                          AS STATUS_VINCULO,

       A.CODFILIAL                       AS CODFILIAL,

       R.RECCREATEDBY                    AS CRIADO_POR,
       R.RECCREATEDON                    AS CRIADO_EM,
       R.RECMODIFIEDBY                   AS ALTERADO_POR,
       R.RECMODIFIEDON                   AS ALTERADO_EM

FROM   SALUNORESPONSAVEL R
       INNER JOIN PPESSOA P ON P.CODIGO = R.CODPESSOA
       INNER JOIN SALUNO A  ON A.CODCOLIGADA = R.CODCOLIGADA
                           AND A.RA          = R.RA

       LEFT  JOIN STIPORESPONSAVEL TR ON TR.CODCOLIGADA = R.CODCOLIGADA
                                     AND TR.CODTIPORESP = R.CODTIPORESP
       LEFT  JOIN PCODPARENT PA       ON PA.CODCLIENTE  = R.CODPARENTESCO

       INNER JOIN SMATRICPL M ON M.CODCOLIGADA = A.CODCOLIGADA
                             AND M.RA          = A.RA
       INNER JOIN SPLETIVO PL ON PL.CODCOLIGADA = M.CODCOLIGADA
                             AND PL.IDPERLET    = M.IDPERLET
WHERE  R.CODCOLIGADA = :CODCOLIGADA
  AND  PL.CODPERLET  = :CODPERLET
GROUP BY R.CODCOLIGADA, R.RA, R.CODPESSOA, P.NOME, P.EMAIL, P.EMAILPESSOAL,
         P.SEXO, P.TELEFONE1, P.TELEFONE2, R.CODTIPORESP, TR.DESCRICAO,
         R.CODPARENTESCO, PA.DESCRICAO, R.STATUS, A.CODFILIAL,
         R.RECCREATEDBY, R.RECCREATEDON, R.RECMODIFIEDBY, R.RECMODIFIEDON
ORDER BY R.RA, R.CODPESSOA;
```

---

## Anexo — o que vivia nos comentários do `.sql`

O `TODDLE.RESP.sql` passou a conter **só SQL** em 20/08/2026, para poder ser colado
direto no cadastro de Sentença do RM. Os comentários que estavam nele estão
preservados abaixo, verbatim: parte já está descrita nas seções acima, parte é
fato medido que não estava documentado em outro lugar. Onde houver divergência,
**as seções acima são mais recentes que este anexo**.

```text
-- ============================================================
-- TODDLE.RESP — responsáveis dos alunos, para o POST /public/v2/parents
--
-- POR QUE UMA SENTENÇA NOVA
--
-- A Sentença de alunos (TODDLE.STUDENTS) devolve 18 colunas e NENHUMA de
-- responsável — conferido em 05/08/2026.
--
-- E não há DataServer para o vínculo acadêmico: `EduAlunoResponsavelData`,
-- `EduAlunoRespData` e `SalunoResponsavelData` não existem. O que existe,
-- `EduResponsavelData`, é a tabela `SResponsavel` = "Responsáveis pela PARCELA DO
-- CONTRATO", ou seja o financeiro do contrato, não o responsável do aluno.
--
-- Nomes de coluna conferidos no dicionário. `SALUNORESPONSAVEL` tem 11 colunas e
-- guarda só o VÍNCULO; nome e e-mail vêm de `PPESSOA`.
--
-- PARÂMETROS: CODCOLIGADA e CODPERLET, como as outras. O recorte de campus é do
-- middleware (RM_CODFILIAL) — a coluna vem no resultado para ser auditável.
-- ============================================================
       -- O GARGALO: o POST /parents exige email. Sem ele, o responsável não
       -- existe no Toddle. Institucional tem precedência; pessoal é fallback.
       -- Tipo e parentesco: viram `relationships[].relationship`.
       -- STATUS do vínculo: só responsável ATIVO deve virar parent. O domínio
       -- ainda NÃO foi medido — o primeiro retorno resolve.
       -- Escopo, vindo do aluno.
       -- Auditoria, mesmo padrão da Sentença de frequência: marca d'água para
       -- sync incremental e distinção humano/integração.
       -- LEFT nos dois: vínculo sem tipo ou sem parentesco cadastrado não deve
       -- desaparecer do resultado. Foi o que quase aconteceu com a justificativa
       -- de falta, onde um INNER teria zerado 21.300 linhas.
       -- Só alunos com matrícula no período letivo pedido, para o volume não
       -- virar o histórico inteiro da escola.
-- O GROUP BY existe porque SMATRICPL pode ter mais de uma linha por aluno
-- (troca de turma gera matrícula nova — medido: 6 alunos com linha ativa E
-- inativa). Sem ele, cada responsável sairia duplicado por matrícula.
--
-- NÃO acrescente TOP nem LIMIT: a Sentença de alunos nasceu com `SELECT TOP 30`
-- e truncou o roster silenciosamente por dias.
--
-- NÃO filtre por STATUS ainda: o domínio não foi medido, e filtrar antes de saber
-- esconde o que precisamos ver.
```

---

## Validação de 20/08/2026 — reconstruída, recadastrada e medida

Primeira execução real desta versão (`CODCOLIGADA=1;CODPERLET=2026`):

| verificação | resultado |
|---|---|
| linhas / `RA` distintos | 594 / 594 — **zero duplicadas** |
| colunas | 12, exatamente as da §2 |
| cobertura do campus 2 | **296 de 296 alunos** — nenhum descoberto |
| resp. acadêmicos distintos (escopo) | 257 |
| resp. financeiros distintos (escopo) | 251 |
| `PARENTESCO_ACADEMICO` | Mãe 447, Pai 106, Outros 10, Enteado(a) 4, nulo 27 |
| `PARENTESCO_FINANCEIRO` | Pai 380, Mãe 173, Outros 21, Avô(ó) 10, Cônjuge 2, nulo 7 |
| `COLIGADA_CFO` | `0` em 334, `1` em 260 |

**O `GROUP BY` fez o que devia:** aluno com mais de uma matrícula no período letivo
não duplicou. Era o risco previsto e não se materializou. Não o remova.

Contra a medição de 05/08 (220 acadêmicos distintos): subiu para 257, coerente com
base viva — a proporção se manteve.

### Três decisões da escola, agora com número

1. **4 alunos do campus 2 sem nenhum e-mail de responsável acadêmico** — nem
   institucional nem pessoal. `POST /parents` exige e-mail, então esses quatro não
   têm responsável importável. Secretaria, não código.
2. **1 aluno sem responsável acadêmico cadastrado** — só o financeiro existe.
3. **37 e-mails ligados a mais de um aluno** (o maior, a 3). É irmão, e define o
   comportamento do sync: **consolidar por e-mail** e vincular o mesmo parent a
   vários alunos, nunca criar um parent por aluno. Reforça a §3.3: `CODPESSOA` e
   `CODCFO` vivem em espaços diferentes e não são comparáveis, então o e-mail é a
   única chave de consolidação.

### Uma diferença de contagem que não é problema

A `RESP` devolve 594 `RA` e a `TODDLE.STUDENTS` devolve 590. Os 4 a mais aparecem
aqui e não lá porque a Sentença de alunos exige turma (`JOIN STURMA`) e esta não —
são alunos matriculados sem turma alocada. Não afeta o sync: o escopo sai do de-para
de `STUDENT`.
