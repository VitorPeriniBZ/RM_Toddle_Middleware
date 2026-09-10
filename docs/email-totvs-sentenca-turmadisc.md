# E-mail — wsConsultaSQL executa versão ANTIGA da Sentença TODDLE.TURMADISC

Escrito em 25/08/2026, revisado depois do export CSV feito pelo próprio RM.
**Não enviado.**

## O que ficou provado

| | |
|---|---|
| Sentença dentro do RM | **correta** — export CSV traz 20 colunas, 672 linhas |
| Dado no banco | **presente** — os e-mails estão em `GUSUARIO.EMAIL` |
| `wsConsultaSQL` | **desatualizado** — devolve 16 colunas, mesma Sentença, mesmos parâmetros |

Não é erro de SQL, de permissão, de parâmetro nem de coligada. É o serviço servindo uma
versão compilada anterior. O e-mail abaixo pede uma coisa só.

---

## Texto

Assunto: `wsConsultaSQL executando versão antiga da Sentença TODDLE.TURMADISC`

Olá,

Precisamos de ajuda com o serviço **wsConsultaSQL**: ele está executando uma versão
anterior da Sentença **TODDLE.TURMADISC**, mesmo depois de a Sentença ter sido
atualizada e salva no RM.

Conseguimos isolar isso com bastante clareza.

**Executando a Sentença DENTRO do RM** (coligada `1`, período letivo `2026`) o resultado
está correto: 672 linhas e **20 colunas**, incluindo as quatro que acrescentamos —
`EMAIL_PROFESSOR`, `EMAIL_PROF_PESSOAL`, `EMAIL_PROF_USUARIO` e `AULAS_SEMANAIS`. Segue
o export em anexo, e os dados estão preenchidos (por exemplo, `EMAIL_PROF_USUARIO` traz
o e-mail dos professores de CODPROF 172 e 174).

**Chamando a MESMA Sentença pelo `wsConsultaSQL`**, com os mesmos parâmetros, vêm 672
linhas e apenas **16 colunas** — as quatro novas não aparecem:

```
ID_TURMADISC, COD_TURMA, NOME_TURMA, CODFILIAL, SEGMENTO, SERIE, TURNO, SECAO,
CODDISC, NOME_DISCIPLINA, CODPROF, NOME_PROFESSOR, TURMADISC_ATIVA,
STATUS_PROF_TURMA, CODPERLET, PERIODO_LETIVO
```

A chamada retorna HTTP 200, sem erro, com a contagem de linhas certa. Ela apenas executa
um `SELECT` que não é mais o que está cadastrado.

Como o mesmo código de Sentença produz resultados diferentes conforme o caminho, parece
que o serviço mantém a Sentença **compilada em cache** e não recarregou a versão nova.

**Podem verificar, por favor:**

1. É necessário **reiniciar o serviço do wsConsultaSQL** (ou o serviço de aplicação do
   RM) para que uma Sentença alterada passe a valer via web service?
2. Existe alguma etapa de **publicação/liberação** da Sentença para uso por web service,
   separada de salvar no cadastro?
3. Há algum cache de Sentenças que possa ser limpo sem reiniciar o serviço?

**Impacto:** enquanto o web service devolver a versão antiga, não conseguimos ler o
e-mail dos professores e dois docentes não podem ser criados no nosso LMS (o cadastro lá
exige e-mail, que funciona como identidade do usuário). Isso deixa 12 vínculos
professor–turma em aberto. Todo o restante da integração está funcionando normalmente
por esse mesmo serviço.

Obrigado,
Vitor Biazutti
Escola Americana de Vitória

---

## Anexar

- `toddleturmadisc.CSV` — o export do RM, que mostra as 20 colunas preenchidas.

Ele é a prova central da mensagem: mesma Sentença, resultados diferentes conforme o
caminho. Sem esse anexo a conversa vira "confere se você salvou".

## Detalhe que NÃO precisa entrar no e-mail

A ordem das colunas no CSV difere levemente do nosso `.sql` (`AULAS_SEMANAIS` vem antes
de `EMAIL_PROF_USUARIO`). Isso é irrelevante — lemos por nome, nunca por posição.
