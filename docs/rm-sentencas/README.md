# Sentenças do RM

Cada `.sql` desta pasta é **colável direto no RM**, sem um único comentário. O
RM normaliza o texto ao salvar e colapsa quebras de linha, o que faz `--`
comentar até o fim da query; o reparse não acha coluna e o save falha com
`Concurrency violation: the UpdateCommand affected 0 of the expected 1 records`.
A documentação fica aqui e nos `.md` ao lado. **`.sql` = máquina, `.md` = gente.**

Todas recebem os mesmos dois parâmetros: `CODCOLIGADA` (Inteiro) e `CODPERLET`
(**Texto** — a coluna é alfanumérica).

| Sentença | Alimenta | Variável no `.env` |
|---|---|---|
| `TODDLE.STUDENTS.V2.sql` | alunos | `RM_SENTENCA_STUDENTS` |
| `TODDLE.STUDENTS.V3.sql` | alunos + curso/matriz | `RM_SENTENCA_STUDENTS` |
| `TODDLE.TURMADISC.V1.sql` | professores, disciplinas, turmas | `RM_SENTENCA_TURMADISC` |

## Por que existe uma V3

A V2 não diz a qual **currículo** o aluno pertence, e sem isso o de-para turma
→ year group é palpite. A EAV tem dois programas com escadas de série
sobrepostas — conferido em `GET /year-groups` por currículo:

- **IB_MYP** (Middle Year Programme): 5 degraus, `Year 1`…`Year 5`
- **UBD** (Independent Programme): 15 degraus, `Pre-K`, `K1`, `K2`, `Year 1`,
  `Grade 2`…`Grade 12`

O 10º ano existe nos dois: `Grade 10` no UBD e `Year 5` no MYP. Os nomes de
coorte também colidem — há dois `Batch of 2028` e dois `Year 1`, com ids
diferentes. Sem saber o curso do aluno, não há critério para escolher.

A V3 resolve trazendo `SHABILITACAOFILIAL` ("Matriz Aplicada") por
`SMATRICPL.IDHABILITACAOFILIAL`: `CODCURSO`, `NOME_CURSO`, `CODHABILITACAO`,
`NOME_HABILITACAO` e `ID_MATRIZ`. O de-para passa a ser
`(curso, série) → year group`, determinado pelo dado.

O middleware já lê essas colunas (`rmStudentSource.ts` → `CourseCode`,
`CourseName`, `AppliedMatrixId`). Trocar V2 por V3 é uma linha no `.env` e não
quebra nada: os apelidos da V2 continuam todos presentes na V3.

A V3 **removeu** `PERIODO_SERIE`. Motivo: no retorno completo ela vem
preenchida **só nas matrículas canceladas** (`CODSTATUS 17`) e vazia nas
ativas — como fallback de série daria valor apenas para aluno inativo.

## TODDLE.TURMADISC.V1

Uma linha por **turma-disciplina-professor**. Caminho no RM:

```
STURMADISC (IDTURMADISC)
  -> SPROFESSORTURMA (CODCOLIGADA + IDTURMADISC)   "Professores da Turma Disciplina"
    -> SPROFESSOR (CODPROF) -> PPESSOA (email)
  -> SDISCIPLINA (CODDISC)
  -> STURMA -> SHABILITACAOFILIAL (curso) / STIPOCURSO (nível)
```

Notas:

- `SPROFESSORTURMA` é N:N — turma-disciplina com dois professores gera duas
  linhas. Não é duplicação, é co-docência. Agrupe por `ID_TURMADISC` no
  middleware, e mande `staffIds[]` com os dois.
- Os JOINs de professor são `LEFT` de propósito: turma-disciplina **sem**
  professor alocado aparece com `NOME_PROFESSOR` nulo, em vez de desaparecer.
  Isso é informação, não erro — turma sem docente é pendência da secretaria.
- `PFUNC` está **vazio** na EAV (a escola não usa o módulo de folha), por isso
  o professor vem de `SPROFESSOR → PPESSOA` e não de `PFUNC`.
- `SPROFESSORTURMA.STATUS` é **numérico**. Comparar com literal de texto dá
  erro de conversão. Trouxe como diagnóstico; o domínio precisa ser levantado
  antes de virar filtro.
- `POST /staff` no Toddle exige `email`. Confira a cobertura de
  `EMAIL_PROFESSOR` **antes** de tentar criar: professor sem e-mail
  institucional não entra, e isso é pendência de RH, não de código.

## Ordem de carga (modelo 2.0 / TeacherCourse)

`GET /curriculums` confirmou `isTeacherCourseEnabled: true` nos dois
currículos. Turma **não** é `POST /courses`.

**Fora do middleware — configuração manual no Toddle.** Currículos, anos
acadêmicos, grades, year groups, grading periods e academic course codes são
**somente GET** na API. Não existe POST para nenhum deles. Quem cria é a
escola no portal ou a equipe do Toddle. O middleware não começa antes disso.

**No middleware, nesta ordem:**

1. **Professores** — `POST /staff` (`email` obrigatório)
2. **Disciplinas** — `POST /subjects`. No MYP exige `presetSubjectId` e
   `subjectGroupId`, obtidos em `GET /org-subject-groups/:curriculumId`. Como
   disciplina é configuração pedagógica, o provável é a escola criar no portal
   e o middleware só ler e mapear `CODDISC`.
3. **Teacher courses** — `POST /teacher-courses`, um por `STURMADISC`.
   Obrigatórios: `title`, `gradeLevels[]`, `subjects[]`, `gradingPeriods[]`,
   `academicCourseId`, `curriculumProgramId`, `defaultGradeLevel`.
4. **Staff no teacher course** — `PUT /teacher-courses/:id/staff/add`
5. **Turmas** — `POST /classes` com `teacherCourseId` e `curriculumProgramId`
6. **Matrícula** — alunos na class

Alunos não dependem de nenhum dos quatro — foi por isso que deu para começar
por eles.

## Pendências que não são código

**Escopo de campus.** `RM_CODFILIAL` está **vazio** no `.env` real (log do
extract sai `campi: "todos"`), então as 586 linhas entram, incluindo o
`CODFILIAL=1` (Infantil + Fundamental I) que a documentação diz estar fora.
Com `=2` seriam ~295. As cinco turmas na DLQ por falta de mapeamento são todas
`PS`: `EAVPS05IA`, `EAVPS05IB`, `EAVPS02MB`, `EAVPS02IB`, `EAVPS01IA`. Ou
preenche `RM_CODFILIAL=2` e a DLQ zera por decisão de escopo, ou mapeia as
cinco. Fazer os dois cria os alunos que não se quer.

**Ambiente.** O token atual é do `Escola Americana de Vitória_Sandbox`
(`organizationId 404045532130986859`), e a estrutura de lá é de demonstração —
vai ser remodelada. Todo `id_mapping` de `YEAR_GROUP` tem prazo de validade, e
o `id_mapping` não tem coluna de ambiente para detectar a troca. E o modelo
**divergiu** entre ambientes: `isTeacherCourseEnabled` era `false` na org
antiga e é `true` aqui. Decidir em qual org o trabalho de turma vai viver
**antes** de escrever o worker de turma.

**Fan-out do `SSTATUS`.** O join é só por `CODCOLIGADA + CODSTATUS`, mas
`SSTATUS` tem `CODTIPOCURSO` — se a escola configurou status por nível de
ensino, a linha do aluno multiplica. Detecta no log do extract: `totalContexts`
maior que `uniqueStudents` é duplicação sendo absorvida pela deduplicação por
RA.
