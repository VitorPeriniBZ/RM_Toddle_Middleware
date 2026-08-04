# Especificação — Sentença `TODDLE.TURMADISC`

O que a Sentença precisa conter para o middleware sincronizar **turmas** e
**professores** com o Toddle. O SQL de partida já está em
`TODDLE.TURMADISC.V1.sql`; este documento diz o que ajustar e por quê.

Escrito a partir do CSV real exportado em 2026-08-03 (campus 2) e da estrutura
medida da API do Toddle. Onde algo não pôde ser verificado, está dito.

---

## 1. Código e publicação — o ponto que hoje bloqueia tudo

**Cadastrar com o código exato `TODDLE.TURMADISC`** e garantir que o usuário do
`.env` tenha permissão nela.

Testei `TURMA DISCIPLINA PROFESSOR`, `TURMADISCIPLINAPROFESSOR`,
`TODDLE.TURMADISC` e `TODDLETURMADISCV1` no wsConsultaSQL: SOAP Fault em todos
(`A consulta SQL utilizando a chave 1|S|<nome> não existe ou não pôde ser
executada por restrição de filtro por perfil/usuário`).

A chave é `coligada|sistema|código` = `1|S|TODDLE.TURMADISC`. Enquanto ela não
responder pelo web service, o dado só existe como CSV exportado à mão e **não há
sincronização automática possível** — nem de turma, nem de professor.

Depois de publicada, o middleware a chama por uma variável nova
(`RM_SENTENCA_TURMADISC`), do mesmo jeito que faz com `RM_SENTENCA_STUDENTS`.

## 2. Parâmetros

Declarar **apenas dois**, iguais aos da Sentença de alunos:

| parâmetro | exemplo |
|---|---|
| `CODCOLIGADA` | 1 |
| `CODPERLET` | 2026 |

**Não declarar `CODFILIAL` e não fixar campus no SQL.** O middleware já filtra
por `RM_CODFILIAL`, e manter a simetria com a Sentença de alunos evita que as
duas divirjam de escopo. Se um dia o volume incomodar, `CODFILIAL` pode entrar
como terceiro parâmetro — mas aí as duas Sentenças precisam mudar juntas.

**Não fixar valores no lugar dos parâmetros.** A Sentença de alunos tinha
`CODCOLIGADA = 1` e `CODPERLET = '2026'` fixos, e o resultado é que o parâmetro
era silenciosamente ignorado: passar 2025, 2026 ou nada devolvia o mesmo. Em
janeiro isso vira uma pegadinha na virada de ano letivo.

## 3. Colunas

### Obrigatórias

| coluna | origem | para que serve |
|---|---|---|
| `COD_TURMA` | `STURMADISC.CODTURMA` | chave da turma; casa com a Sentença de alunos e vira o `sourcedId` da Class |
| `NOME_TURMA` | `STURMA.NOME` | título da Class no Toddle |
| `SEGMENTO` | derivada (ver §4) | com `SERIE`, resolve o year group |
| `SERIE` | derivada (ver §4) | idem |
| `SECAO` | derivada (ver §4) | distingue turma A de B da mesma série |
| `CODDISC` | `STURMADISC.CODDISC` | chave da disciplina |
| `NOME_DISCIPLINA` | `SDISCIPLINA.NOME` | rótulo da disciplina |
| `ID_TURMADISC` | `STURMADISC.IDTURMADISC` | chave estável de turma-disciplina |
| `CODPROF` | `SPROFESSORTURMA.CODPROF` | **única chave estável de professor** — vira o `sourceId` do staff |
| `NOME_PROFESSOR` | `PPESSOA.NOME` | nome completo; o middleware divide em first/last |
| `EMAIL_PROFESSOR` | `PPESSOA.EMAIL` | **`POST /staff` do Toddle EXIGE e-mail** |
| `EMAIL_PROF_PESSOAL` | `PPESSOA.EMAILPESSOAL` | fallback quando o institucional falta |
| `CODFILIAL` | `STURMADISC.CODFILIAL` | escopo de campus |
| `TURMADISC_ATIVA` | `STURMADISC.ATIVA` | filtro (ver §5) |
| `STATUS_PROF_TURMA` | `SPROFESSORTURMA.STATUS` | filtro (ver §5) |
| `CODPERLET` | `SPLETIVO.CODPERLET` | ano letivo |

### Vale incluir

| coluna | por que |
|---|---|
| `AULAS_SEMANAIS` (`SPROFESSORTURMA.AULASSEMANAISPROF`) | Com 2 ou 3 professores na mesma turma-disciplina — que é a **regra**, não exceção — não existe campo de titular em `SPROFESSORTURMA`. O número de aulas semanais é o único critério objetivo disponível para desempatar, se o Toddle precisar de um professor principal. |
| `TURNO` | derivada; separa Integral de Matutino no Infantil |

### Podem sair

Medidas no CSV completo do campus 2, todas sem poder discriminante:

- **`NOME_CURSO`** — vazia em 100% das linhas (`SHABILITACAOFILIAL.DESCRICAOCURSO` não preenchida)
- **`NIVEL_ENSINO`** — `Ensino Básico` em 100%
- **`CHAPA`** — vazia em 100%; sem vínculo com `PFUNC`
- **`CODCURSO`** — só `MS` e `HS`; é a mesma informação de `SEGMENTO`
- **`NOME_DISC_REDUZIDO`** — redundante com `NOME_DISCIPLINA`

Manter não faz mal; só não conte com elas.

## 4. As três colunas derivadas

`COD_TURMA` tem **exatamente 9 caracteres em todas as 35 turmas**, no formato
`EAV` + segmento(2) + série(2) + turno(1) + seção(1). Verificado uma a uma:

```sql
SUBSTRING(TD.CODTURMA, 4, 2)  AS SEGMENTO,   -- PS | ES | MS | HS
SUBSTRING(TD.CODTURMA, 6, 2)  AS SERIE,      -- 01..12
SUBSTRING(TD.CODTURMA, 8, 1)  AS TURNO,      -- I=Integral | M=Matutino
SUBSTRING(TD.CODTURMA, 9, 1)  AS SECAO       -- A | B | G
```

**Cuidado: `SERIE` sozinha NÃO é única.** `PS01`–`PS05` (Infantil) e
`ES01`–`ES05` (Fundamental I) colidem nos valores `01`–`05`. A chave de série é
sempre **`SEGMENTO` + `SERIE`**. No campus 2 isso não morde (só `MS06`–`MS09` e
`HS10`–`HS12`), mas se o campus 1 entrar em escopo, mapear por `SERIE` sozinha
manda Infantil e Fundamental I para o mesmo year group.

## 5. Não filtre — devolva os flags

**Não coloque `AND TD.ATIVA = 'S'` nem `AND PT.STATUS = 1` no `WHERE`.**

No CSV completo os dois vêm com **um único valor** (`S` e `1`), então o domínio é
desconhecido — não se sabe o que os outros valores significam nem se existem.
Filtrar agora é chutar.

A lição vem da Sentença de alunos: lá, expor o flag `STATUS_ATIVO` em vez de
filtrar revelou que "ativo" cobre **quatro** códigos de status (Matriculado,
Matrícula em andamento, Aluno Visitante, Matrícula não enturmado). Uma lista
manual de códigos teria descartado 26 alunos silenciosamente.

Mesma razão para manter o `LEFT JOIN` em `SPROFESSORTURMA`: turma-disciplina sem
professor atribuído deve **aparecer** com professor nulo, para o problema ficar
visível em vez de a linha desaparecer.

## 6. O que o middleware faz com isso

```
COD_TURMA + NOME_TURMA + SEGMENTO/SERIE  ->  TeacherCourse (1 por série)
                                              + Class (1 por turma)
CODPROF + NOME + EMAIL                   ->  Staff
CODDISC                                  ->  vínculo staff <-> class
```

Idempotência pelo `sourcedId`: `rm:<codfilial>:section:<COD_TURMA>` para a Class
e `rm:staff:<CODPROF>` para o professor — o mesmo desenho que já funciona nos
alunos.

## 7. O que continua faltando depois desta Sentença

Publicar `TODDLE.TURMADISC` **não** destrava tudo. Seguem pendentes:

1. **Academic course codes reais no portal do Toddle.** O `POST /teacher-courses`
   exige `academicCourseId` (a API responde
   `Academic Course ID is required. Teacher courses can only be created when
   linked to an academic course.`). Existem 25 no UBD, **todos de
   demonstração**, e só 6 são de nível série (`Y1`–`Y6`). Faltam os de `Grade 7`
   a `Grade 12`. Não há `POST` para criá-los — é portal ou ticket ao Toddle.
2. **E-mails de 5 professores no RM:** 3 sem e-mail nenhum (CODPROF 165, 169,
   166) e 2 com e-mail inválido (104 com domínio `escolaameriana` sem o "c"; 124
   com `lojaode@gmail.com` no campo institucional).
3. **Definir a organização Toddle final** — a atual é sandbox descartável.
