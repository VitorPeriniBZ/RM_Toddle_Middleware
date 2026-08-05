# Especificação — Sentença `TODDLE.RESP` (responsáveis)

Para vincular responsáveis no Toddle. O SQL está em `TODDLE.RESP.sql`.

**Estado: escrita, NÃO cadastrada, NÃO verificada.** Escrita em 05/08/2026 com os
nomes de coluna conferidos no dicionário do RM. Tudo aqui que não estiver marcado
como medido é dedução da estrutura, não observação.

---

## 1. A resposta curta: sim, precisa de duas requisições novas

**No RM: uma Sentença.** A de alunos devolve 18 colunas e **nenhuma** de
responsável (medido). E não existe DataServer para o vínculo acadêmico:

| nome tentado | resultado |
|---|---|
| `EduAlunoResponsavelData` | não existe |
| `EduAlunoRespData` | não existe |
| `SalunoResponsavelData` | não existe |
| `EduResponsavelData` | **existe, mas é outra coisa** — ver abaixo |

`EduResponsavelData` expõe a tabela `SResponsavel` = *"Responsáveis pela **Parcela
do Contrato**"*, com `IDPARCELA`, `CODCFO`, `PERCENTUAL`, `CODSERVICO`. É o
responsável **financeiro do contrato**, não o responsável do aluno. Usá-lo por
engano traria quem paga, não quem responde pela criança.

**No Toddle: um endpoint separado.** `POST /public/v2/parents` — não é campo do
aluno.

## 2. O que o Toddle exige

| campo | obrigatório | de onde vem |
|---|---|---|
| `firstName` | **sim** | `PPESSOA.NOME`, primeira palavra |
| `lastName` | **sim** | `PPESSOA.NOME`, resto |
| `email` | **sim** | `PPESSOA.EMAIL` / `EMAILPESSOAL` |
| `children` | **sim** — array de `studentId` | `RA` → `id_mapping` `STUDENT` |
| `relationships` | não — `[{childId, relationship}]` | `PCODPARENT.DESCRICAO` |
| `gender` | não | `PPESSOA.SEXO` |
| `middleName` | não | — |

Endpoints: `POST /parents`, `PUT /parents/:id`, `GET /parents`. **Não há `DELETE`**
— coerente com aluno e turma.

### 2.1 `children` é array: um responsável, uma requisição

Um responsável com três filhos é **uma** chamada com três ids em `children`, não
três chamadas. Isso define a chave do de-para: **`CODPESSOA`**, a pessoa — não o
RA. O tipo `PARENT` já existe no `id_mapping`.

Consequência prática: o sync de responsáveis é agrupado por pessoa, e mudança de
matrícula de **um** filho exige `PUT` no responsável inteiro.

## 3. O gargalo é o e-mail, e eu NÃO consegui medi-lo

`email` é obrigatório no `POST /parents`. Sem ele, o responsável não existe no
Toddle.

**Não sei a cobertura de e-mail dos responsáveis desta escola.** Tentei medir sem
depender de Sentença nova e não deu: não há DataServer para `SALUNORESPONSAVEL`.
Então o volume e a cobertura só aparecem quando a Sentença rodar.

Precedente que justifica a preocupação: **5 professores ficaram sem e-mail no RM** e
por isso não puderam ser criados como staff no Toddle. O mesmo pode acontecer aqui,
e com mais gente.

Quando a Sentença responder, quero reportar:

1. **cobertura de e-mail** — quantos responsáveis têm, quantos não;
2. **e-mails compartilhados** — pai e mãe com o mesmo endereço. Se o Toddle exigir
   e-mail único (provável), isso é conflito, não detalhe;
3. **domínio de `STATUS`** do vínculo — só responsável ativo deve virar parent;
4. **domínio de `CODTIPORESP`** — separar acadêmico de financeiro;
5. **responsáveis por aluno** — mínimo, máximo, e quantos alunos ficam sem nenhum;
6. **filhos por responsável** — dimensiona o agrupamento;
7. **`CODPESSOA` duplicado com nomes diferentes**, que indicaria cadastro sujo.

## 4. Onde o RM guarda (conferido no dicionário)

| tabela | papel |
|---|---|
| `SALUNORESPONSAVEL` | **o vínculo** (11 colunas): `CODCOLIGADA + RA + CODPESSOA`, mais `CODTIPORESP`, `CODPARENTESCO`, `STATUS` |
| `PPESSOA` | os dados: `NOME`, `EMAIL`, `EMAILPESSOAL`, `SEXO`, `TELEFONE1..3` |
| `STIPORESPONSAVEL` | descrição do tipo (acadêmico, financeiro) |
| `PCODPARENT` | descrição do parentesco — a chave é `CODCLIENTE`, não `CODPARENTESCO` |

Há também atalhos desnormalizados em `SALUNO`: `CODPESSOARACA` + `CODPARENTRACA`
(responsável acadêmico) e `CODPARENTCFO` (financeiro). **Não os usei**: guardam um
só responsável, e a tabela de vínculo guarda todos. Se a Sentença vier vazia, esses
campos são o plano B.

## 5. Duas decisões de desenho embutidas no SQL

**`LEFT JOIN` em `STIPORESPONSAVEL` e `PCODPARENT`.** Vínculo sem tipo ou sem
parentesco cadastrado não deve desaparecer. Foi o que quase aconteceu com a
justificativa de falta, onde um `INNER` teria zerado 21.300 linhas.

**`GROUP BY` no fim.** `SMATRICPL` pode ter mais de uma linha por aluno — troca de
turma gera matrícula nova, e isso está **medido**: 6 alunos têm simultaneamente
matrícula ativa e inativa. Sem o `GROUP BY`, cada responsável sairia duplicado por
matrícula.

## 6. O que NÃO fazer

- **Sem `TOP`/`LIMIT`.** A Sentença de alunos nasceu com `SELECT TOP 30` e truncou
  o roster por dias.
- **Sem filtrar `STATUS` ainda.** O domínio não foi medido; filtrar antes de saber
  esconde o que precisamos ver.
- **Não confundir com `EduResponsavelData`** (§1).
- **Não usar o CPF** que `PPESSOA` traz. Mesma regra da frequência: dado pessoal
  não persiste no middleware nem entra em log.

## 7. Ordem sugerida

1. Cadastrar `TODDLE.RESP` e preencher `RM_SENTENCA_RESPONSAVEIS` no `.env` (a
   variável ainda **não existe** — entra junto).
2. Rodar leitura e reportar os 7 itens de §3. **Zero escrita.**
3. Só então decidir: quem tem e-mail vira `parent`; quem não tem vira pendência
   para a secretaria, nunca e-mail inventado.
4. `POST /parents` com `children` agrupado por `CODPESSOA`, de-para em
   `id_mapping` tipo `PARENT`.

## 8. Uma pergunta de produto, antes de escrever no Toddle

Responsável no Toddle **recebe acesso ao LMS** — vê notas, frequência e
comunicados do filho. Criar 400 contas de pai e mãe não é sincronizar dado, é
**dar acesso a pessoas**.

Isso merece decisão explícita da escola sobre quem entra, e provavelmente
comunicação antes. Diferente de aluno e turma, aqui o efeito colateral de um
`POST` errado é uma pessoa vendo dado de uma criança que não é dela.
