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

`TODDLE.RESP.sql` no repositório é a minha primeira versão, sobre
`SALUNORESPONSAVEL`. **Devolve zero nesta instalação**, mas fica: se a escola
passar a popular aquela tabela, ele é o caminho melhor, porque dá vários
responsáveis por aluno, ID estável (`CODPESSOA`) e `STATUS` do vínculo.
