# Responsáveis — especificação, e por que a Sentença não é o caminho

**Conclusão de 05/08/2026: a Sentença `TODDLE.RESP` está cadastrada e correta, mas
devolve ZERO linhas. Os dados de responsável existem, e vêm do DataServer
`EduAlunoData` — não é preciso Sentença nenhuma.**

Isto **corrige** o que eu havia dito ("precisa de duas requisições novas"). Do
lado do RM não precisa; do lado do Toddle sim.

---

## 1. O que aconteceu com a Sentença

`TODDLE.RESP` responde pelo web service com `<NewDataSet />` — zero linhas, **sem
SOAP Fault e sem erro de permissão**. Ou seja: cadastrada com o código certo,
permitida ao usuário, e o SQL simplesmente não casou nada.

Os joins estão corretos, conferidos um a um contra a `GLINKSREL`:

```
SALUNORESPONSAVEL → PPESSOA            CODPESSOA = CODIGO          ✓
SALUNORESPONSAVEL → SALUNO             CODCOLIGADA + RA            ✓
SALUNO            → SMATRICPL          CODCOLIGADA + RA            ✓
SMATRICPL         → SPLETIVO           CODCOLIGADA + IDPERLET      ✓
STIPORESPONSAVEL                       CODCOLIGADA + CODTIPORESP   ✓
PCODPARENT                             CODCLIENTE = CODPARENTESCO  ✓
```

**A causa é `SALUNORESPONSAVEL` estar vazia** nesta instalação. Confirmado por
outro caminho: em 30 alunos lidos via `EduAlunoData`, os atalhos
`CODPESSOARACA`, `CODPARENTRACA`, `CODPARENTCFO` e `CODCFO` estão **nulos em
30/30**. A escola não popula a tabela de vínculo nem os campos de atalho.

O arquivo `TODDLE.RESP.sql` fica no repositório: se a escola passar a usar
`SALUNORESPONSAVEL`, ele é o caminho certo — dá parentesco e ID estável, que o
DataServer não dá.

## 2. De onde os dados vêm de verdade

O `ReadView` de **`EduAlunoData`** (elemento `SAluno`) resolve na própria view:

```
RESPACADEMICO         253/253   (100,0%)
EMAILRESPACADEMICO    252/253   ( 99,6%)
RESPFINANCEIRO        253/253   (100,0%)
EMAILRESPFINANCEIRO   250/253   ( 98,8%)

alunos sem NENHUM e-mail de responsável:  0
```

Medido sobre os 253 alunos em escopo, em lotes de 25.

**O gargalo que eu temia não existe.** Eu havia escrito que o e-mail obrigatório do
`POST /parents` era o risco, com o precedente dos 5 professores sem e-mail. Aqui a
cobertura é 99,6% e **nenhum aluno fica sem responsável alcançável**.

## 3. O que o Toddle receberia

```
parents distintos (chave = e-mail):  396

filhos por parent:
   1 filho    333
   2 filhos    60
   3 filhos     2
   8 filhos     1   ← ver §4.2
```

Endpoint: `POST /public/v2/parents`. Exige `firstName`, `lastName`, `email` e
`children[]`; aceita `relationships[{childId, relationship}]` e `gender`. Não há
`DELETE` — só `POST`, `PUT` e `GET`.

Como `children` é array, **um responsável é uma requisição**, não uma por filho.

## 4. Três coisas para decidir antes de escrever

### 4.1 Cinco e-mails pertencem a pessoas DIFERENTES

De 396 e-mails, **5 aparecem com nomes diferentes**:

```
dr***@gmail.com        Alexsandro / Adriana
ta***@gmail.com        Luiz / Tatiana
le***@gmail.com        Alexandre / Richardeny
al***@hotmail.com.br   Alexandra / Eduardo
tk***@hotmail.com      Kesia / Raphael
```

Parecem casais compartilhando um endereço. No Toddle o e-mail é a identidade, então
**só um dos dois pode existir**. As opções: escolher um por regra (o acadêmico,
por exemplo), ou pedir e-mail separado à secretaria. Não é decisão minha.

Os outros compartilhamentos são benignos e não precisam de nada:

- **62 e-mails** aparecem com o **mesmo nome em mais de um aluno** — são irmãos, e
  o `children[]` resolve;
- **35 alunos** têm o mesmo e-mail como acadêmico **e** financeiro — é a mesma
  pessoa nos dois papéis.

### 4.2 Um responsável com 8 filhos

Um e-mail está ligado a 8 alunos. Pode ser família grande, mas 8 é bastante — vale
a secretaria conferir se não é um endereço institucional ou cadastro repetido. Se
for institucional, criar esse parent dá a uma pessoa acesso ao dado de 8 crianças.

### 4.3 O que o DataServer NÃO dá, e o custo disso

| falta | consequência |
|---|---|
| `CODPESSOA` (ID estável) | a chave do de-para tem de ser o **e-mail**. Se a escola trocar o e-mail de um responsável, perdemos o vínculo e ele viraria um parent novo |
| parentesco (Mãe, Pai, Avó) | `relationships[]` fica limitado a *"acadêmico"* / *"financeiro"* |
| terceiro responsável | a view devolve só um acadêmico e um financeiro. Aluno com três responsáveis perde o terceiro, e não temos como saber que existe |

O primeiro é o mais sério, e é o argumento para a escola passar a popular
`SALUNORESPONSAVEL` algum dia. Mitigação possível: guardar o e-mail **e** um hash do
nome normalizado, para detectar troca de e-mail em vez de criar duplicata em
silêncio.

## 5. A decisão que não é técnica

Responsável no Toddle **recebe acesso ao LMS** — vê nota, frequência e comunicado
do filho. Criar 396 contas não é sincronizar dado, é **dar acesso a pessoas**.

Diferente de aluno e turma, o efeito colateral de um `POST` errado aqui é alguém
vendo dado de uma criança que não é dela — e os §4.1 e §4.2 são exatamente onde
isso pode acontecer.

Isso precisa de decisão explícita da escola sobre quem entra, e provavelmente de
comunicação antes. Não é coisa para executar por iniciativa própria.

## 6. Ordem sugerida

1. **Nada a cadastrar no RM.** A leitura sai do `EduAlunoData`, que já usamos.
2. Implementar a leitura no middleware, com o mesmo padrão da frequência: sem
   propagar dado pessoal além do necessário, de-para em `id_mapping` tipo `PARENT`
   (que já existe), agrupado por e-mail.
3. Levar §4.1, §4.2 e §5 para a escola decidir.
4. Só então `POST /parents`, em ensaio primeiro.
