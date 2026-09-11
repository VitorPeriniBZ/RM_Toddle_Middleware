# Especificação — Sentença `TODDLE.TURMADISC`

O que a Sentença precisa conter para o middleware sincronizar **turmas** e
**professores** com o Toddle. O SQL está em `TODDLE.TURMADISC.sql`, puro e colável
no RM; este documento diz por que ele é assim.

> A V1 original (`TODDLE.TURMADISC.V1.sql`) foi removida em 20/08/2026: não tinha
> `SEGMENTO`/`SERIE`/`SECAO`, que `rmTeacherSource.ts` lê. A canônica é a que
> ficou. O histórico da V1 está no anexo, no fim deste arquivo.

Escrito a partir do CSV real exportado em 2026-08-03 (campus 2) e da estrutura
medida da API do Toddle. Onde algo não pôde ser verificado, está dito.

---

## 1. Código e publicação — resolvido em 20/08/2026

> **Já está publicada e respondendo** (672 linhas — ver a validação no fim do
> arquivo). Esta seção fica como registro de como diagnosticar se ela cair de novo:
> foi exatamente o que aconteceu na cópia de base de 13–15/08, que levou as cinco
> Sentenças junto com o usuário `integracao.toddle`.

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
| `EMAIL_PROF_USUARIO` | `GUSUARIO.EMAIL` | terceiro caminho, acrescentado em 25/08/2026 (`8b08e89`): cinco professores vinham sem e-mail pelos dois primeiros |
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

1. ~~**Academic course codes reais no portal do Toddle.**~~ **RESOLVIDO — medido em
   21/08/2026.** Continua verdade que o `POST /teacher-courses` exige
   `academicCourseId` e que **não há `POST`** para criar academic course (só
   `GET /public/v2/academic-course-codes`), então isso segue sendo portal ou
   ticket ao Toddle. Mas os códigos que faltavam **existem**:

   | currículo | academic course codes | teacher courses |
   |---|---|---|
   | `...975` | 18 (`Yr1`–`Yr5`, `GR-5`, `GR-6`) | 16 ACTIVE, séries Year 1–5 |
   | `...976` | 25 (`Y1`–`Y6`, e `Y7`–`Y12` por disciplina) | 100 ACTIVE, séries Grade 6–12 |

   Os 116 teacher courses casam **exatamente** com os 116 mapeamentos
   `TEACHER_COURSE` do de-para — nada apontando para o vazio. A afirmação
   anterior ("só 6 são de nível série, faltam Grade 7 a Grade 12") está
   desatualizada: hoje há `Y7 ENG/MATHS/SCI`, `Y8 ENG/MATHS/SCI`,
   `Y9 ENG/MATHS/SOCIAL`, `Y10 ACC/ENG/MATHS/SCI`, `Y11 ENG/MATHS/SCI` e
   `Y12 BIO/CS/ENG`.

   **O que isso destrava e o que não:** criar turma para uma combinação
   (série, disciplina) que **já tem** teacher course é possível hoje. Combinação
   NOVA continua dependendo de alguém criar o academic course no portal — e é
   isso que pode morder na virada de 2027, se a escola oferecer disciplina nova.

   Nota de leitura da API: o `GET /teacher-courses` **não devolve**
   `academicCourseId` (devolve `code`, tipo `C-<id>`), embora o `POST` o exija.
   Não conclua "teacher course sem academic course" a partir do GET.
2. **E-mails de 5 professores no RM:** 3 sem e-mail nenhum (CODPROF 165, 169,
   166) e 2 com e-mail inválido (104 com domínio `escolaameriana` sem o "c"; 124
   com `lojaode@gmail.com` no campo institucional).
3. **Definir a organização Toddle final** — a atual é sandbox descartável.

---

## Anexo — o que vivia nos comentários do `.sql`

O `TODDLE.TURMADISC.sql` passou a conter **só SQL** em 20/08/2026, para poder ser colado
direto no cadastro de Sentença do RM. Os comentários que estavam nele estão
preservados abaixo, verbatim: parte já está descrita nas seções acima, parte é
fato medido que não estava documentado em outro lugar. Onde houver divergência,
**as seções acima são mais recentes que este anexo**.

```text
-- ============================================================
-- Sentença RM: TODDLE.TURMADISC
-- Turma x Disciplina x Professor — fonte para sincronizar TURMAS e PROFESSORES
-- com o Toddle. Consumida pelo middleware via wsConsultaSQL.
--
-- CADASTRAR COM ESTE CÓDIGO EXATO: a chave que o web service usa é
-- coligada|sistema|código = 1|S|TODDLE.TURMADISC. O usuário do .env precisa ter
-- permissão nela. Testado em 2026-08-03: TURMA DISCIPLINA PROFESSOR,
-- TURMADISCIPLINAPROFESSOR, TODDLE.TURMADISC e TODDLETURMADISCV1 dão SOAP Fault
-- ("não existe ou não pôde ser executada por restrição de filtro").
--
-- Base: TODDLE.TURMADISC.V1.sql (JOINs conferidos na GLINKSREL do RM, mantidos).
-- Mudanças, e o porquê de cada uma:
--
--   + SEGMENTO / SERIE / TURNO / SECAO  derivadas de COD_TURMA. É o que resolve
--     o year group do Toddle. Ver bloco abaixo.
--   + AULAS_SEMANAIS  co-docência é a REGRA nesta escola (70 das 202
--     turma-disciplinas do campus 2 têm 2 ou 3 professores) e SPROFESSORTURMA
--     NÃO tem campo de titular. Nº de aulas semanais é o único critério
--     objetivo disponível para eleger um professor principal, se o Toddle exigir.
--   - NOME_CURSO, NIVEL_ENSINO, CHAPA, CODCURSO, NOME_DISC_REDUZIDO removidas:
--     medidas no export completo do campus 2, vêm vazias ou constantes em 100%
--     das linhas (NOME_CURSO vazia; NIVEL_ENSINO sempre "Ensino Básico"; CHAPA
--     vazia — sem vínculo com PFUNC; CODCURSO só MS/HS, mesma informação de
--     SEGMENTO). Se algum dia forem preenchidas, é só reincluir.
--
-- PARÂMETROS: apenas CODCOLIGADA e CODPERLET, iguais aos da Sentença de alunos.
-- NÃO fixar valores no lugar deles: a Sentença de alunos tinha CODCOLIGADA = 1 e
-- CODPERLET = '2026' hardcoded, e o efeito era o parâmetro ser silenciosamente
-- ignorado — passar 2025, 2026 ou nada devolvia o mesmo resultado.
--
-- NÃO filtrar por campus aqui: o middleware filtra por RM_CODFILIAL, e manter a
-- simetria com a Sentença de alunos evita que as duas divirjam de escopo.
-- ============================================================
       -- --- identidade ---
       -- --- derivadas de COD_TURMA ---
       -- Formato verificado nas 35 turmas, 9 caracteres, sem exceção:
       --   EAV + segmento(2) + série(2) + turno(1) + seção(1)
       --   EAVHS10IA -> HS | 10 | I | A       EAVPS02MB -> PS | 02 | M | B
       -- ATENÇÃO: SERIE sozinha NÃO é única — PS01..PS05 (Infantil) colidem com
       -- ES01..ES05 (Fundamental I). A chave de série é SEGMENTO + SERIE.
       -- --- disciplina ---
       -- --- professor ---
       -- CODPROF é a ÚNICA chave estável de professor: CHAPA vem vazia em 100%
       -- das linhas, então não há vínculo com a folha (PFUNC).
       -- O POST /staff do Toddle EXIGE e-mail, e o usa como identidade. Os dois
       -- campos vêm porque o institucional falta em parte do cadastro.
       -- --- flags: DEVOLVIDOS, não filtrados (ver nota no final) ---
       -- --- período letivo ---
-- LEFT JOIN nos três a seguir de propósito: turma-disciplina SEM professor
-- atribuído deve APARECER, com professor nulo, para o problema ficar visível.
-- Com INNER JOIN a linha desapareceria do roster silenciosamente.
-- Ordenação por CÓDIGO, não por nome: é determinística e não muda se a escola
-- renomear turma, disciplina ou professor.
-- ============================================================
-- POR QUE NÃO HÁ FILTRO DE "ATIVO" AQUI
--
-- Não acrescente "AND TD.ATIVA = 'S'" nem "AND PT.STATUS = 1".
--
-- No export completo do campus 2 os dois campos vêm com um ÚNICO valor ('S' e
-- '1'), então o domínio é desconhecido: não se sabe que outros valores existem
-- nem o que significam. Filtrar agora é chute.
--
-- A lição vem da Sentença de alunos: lá, DEVOLVER o flag em vez de filtrar
-- revelou que "ativo" no RM cobre QUATRO códigos de status (Matriculado,
-- Matrícula em andamento, Aluno Visitante, Matrícula não enturmado). Uma lista
-- manual de códigos teria descartado 26 alunos em silêncio.
--
-- O middleware filtra, e o faz com o flag à vista no log.
-- ============================================================
```

---

## Validação de 20/08/2026 — recadastrada e medida

| verificação | resultado |
|---|---|
| linhas | 672 |
| chave `(ID_TURMADISC + CODPROF)` | 672 distintas — **zero duplicadas** |
| `CODFILIAL` | campus 2: 304; campus 1: 368 |
| `SEGMENTO` | `ES` 243, `MS` 197, `PS` 125, `HS` 107 |
| `TURMADISC_ATIVA` | `S` em 100% |
| `STATUS_PROF_TURMA` | `1` em 669, nulo em 3 |
| turma-disciplina sem professor (campus 2) | 0 |
| professores distintos no campus 2 | 37 — **5 sem `EMAIL_PROFESSOR`** |

A chave única confirma que co-docência sai como **linha por professor**, não como
duplicata: agrupe por `ID_TURMADISC` no middleware e mande `staffIds[]`.

> ⚠️ **`AULAS_SEMANAIS` vem sempre NULA.** Medido: omitida em 100% das linhas. Isso
> derruba o critério que a §4 propunha para eleger professor principal em turma com
> co-docência — `SPROFESSORTURMA.AULASSEMANAISPROF` não é preenchido nesta base.
> **Não existe hoje critério objetivo de titularidade.** Se o Toddle exigir um
> professor principal, a regra terá de vir da coordenação, não do dado.

**Pendência que não é código:** os 5 professores sem e-mail institucional não podem
ser criados (`POST /staff` exige `email`). É RH/secretaria.
