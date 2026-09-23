# Sentenças do RM

Cada `.sql` desta pasta é **colável direto no RM**, sem um único comentário. O
RM normaliza o texto ao salvar e colapsa quebras de linha, o que faz `--`
comentar até o fim da query; o reparse não acha coluna e o save falha com
`Concurrency violation: the UpdateCommand affected 0 of the expected 1 records`.
A documentação fica aqui e nos `.md` ao lado. **`.sql` = máquina, `.md` = gente.**

**Parâmetro é `:NOME`, nunca `@NOME`.** O TOTVS **não aceita** a sintaxe `@` do
T-SQL no corpo da Sentença — confirmado por Vitor em 20/08/2026, ao cadastrar. Isso
vale inclusive dentro de função: `CAST(:DATAINICIAL AS VARCHAR(8))`, não
`CAST(@DATAINICIAL ...)`. O `TODDLE.FREQ.sql` ficou com `@` por meses porque foi
transcrito como T-SQL comum; é o tipo de erro que só aparece na hora de colar.

A maioria recebe os mesmos dois parâmetros: `CODCOLIGADA` (Inteiro) e
`CODPERLET` (**Texto** — a coluna é alfanumérica). As exceções são `TODDLE.FREQ` e
`TODDLE.PLANOAULA`, que recebem **quatro** (mais `DATAINICIAL` e `DATAFINAL`,
estilo 112 / `YYYYMMDD`) — nas duas, o volume anual não cabe numa resposta só.

| Sentença | Alimenta | Variável no `.env` | linhas | chave |
|---|---|---|---|---|
| `TODDLE.STUDENTS.sql` | alunos + curso/matriz | `RM_SENTENCA_STUDENTS` | 597 | 590 RA — **7 dup.** |
| `TODDLE.TURMADISC.sql` | professores, disciplinas, turmas | `RM_SENTENCA_TURMADISC` | 672 | única |
| `TODDLE.RESP.sql` | responsáveis | `RM_SENTENCA_RESPONSAVEIS` | 594 | única |
| `TODDLE.FREQ.sql` | frequência (leitura) | `RM_SENTENCA_FREQUENCIA` | 2.455¹ | única |
| `TODDLE.NOTAS.sql` | notas de etapa | `RM_SENTENCA_NOTAS` | 7.268 | única |
| `TODDLE.PLANOAULA.sql` | plano de aula + autoria² | (sem variável) | — | cadastrada |

¹ fevereiro/2026; a Sentença exige janela de data.
² Cadastrada no RM em **21/08/2026** e conferida em 11/09/2026 — o README dizia
"a cadastrar" até então, porque ninguém voltou para corrigir. Continua **não
executada**, e o fluxo que ela serve está bloqueado: o Toddle não expõe plano de
aula na API. Ver `TODDLE.PLANOAULA.ESPEC.md` §7. Também recebe **quatro**
parâmetros, como a `TODDLE.FREQ`. Não tem variável no `.env` porque nada a lê.

Cada Sentença tem exatamente **um `.sql`** (puro) e **um `.ESPEC.md`** (a
documentação). Consolidado em 20/08/2026: existiam `.V1`/`.V2`/`.V3` soltos, sem
dizer qual valia.

> **As cinco foram recadastradas e validadas em 20/08/2026**, depois de a cópia de
> base de 13–15/08 tê-las levado junto com o usuário `integracao.toddle`.
>
> `TODDLE.NOTAS` e `TODDLE.RESP` foram **reconstruídas** nesta data (nunca tinham
> sido commitadas; só existiam dentro do RM) e validadas na execução. Ver §6 de
> `TODDLE.NOTAS.ESPEC.md` e o anexo de `TODDLE.RESP.ESPEC.md`.

## Conferência de 11/09/2026 — cinco batem, e o repositório é que estava velho

Antes de mais uma cópia de base sobre o dev, as seis foram lidas **do RM** e
comparadas com os `.sql` daqui (`./exportar-sentencas.sh`):

| Sentença | corpo no RM vs `.sql` | última alteração no RM | TAMANHO |
|---|---|---|---|
| `TODDLE.STUDENTS` | idêntico | 20/08/2026 14:45 | 2.066 |
| `TODDLE.RESP` | idêntico | 20/08/2026 14:54 | 1.541 |
| `TODDLE.FREQ` | idêntico | 20/08/2026 10:04 | 2.572 |
| `TODDLE.NOTAS` | idêntico | 20/08/2026 14:41 | 2.719 |
| `TODDLE.PLANOAULA` | idêntico | 21/08/2026 14:53 | 2.877 |
| `TODDLE.TURMADISC` | **`.sql` desatualizado** | 25/08/2026 11:41 | 2.059 |

**A direção da divergência é a que assusta.** Não é o RM que está velho — é o
`.sql` da `main`. O RM tem o terceiro caminho de e-mail:

```sql
       GU.EMAIL                       AS EMAIL_PROF_USUARIO
LEFT JOIN GUSUARIO GU ON GU.CODUSUARIO = PP.CODUSUARIO
```

Conferido três vezes: está no corpo lido por `ReadRecord`, **e a execução de
hoje devolve a coluna `EMAIL_PROF_USUARIO`**. O `.sql` da `main` não tinha
nenhum dos dois — só a branch `refactor/config-por-tenant` (commit `8b08e89`,
25/08 09:41), que nunca foi mergeada. O RM foi recadastrado duas horas depois
daquele commit, às 11:41; o repositório ficou para trás.

Isso importa porque o `.sql` **é a fonte de restauração**. Recadastrar a partir
da `main` teria *rebaixado* o RM, reintroduzindo exatamente o bug que o
`8b08e89` consertou — cinco professores sem e-mail, sem erro nenhum, porque
coluna que não existe vira `undefined` e é indistinguível de "o RM não tem esse
dado". Já tinha acontecido com a `TODDLE.RESP`. Seria a terceira vez.

O `.sql` desta pasta foi atualizado a partir do RM em 11/09/2026. Hoje nada
quebra em execução: o `rmTeacherSource.ts` da `main` só lê `EMAIL_PROFESSOR` e
`EMAIL_PROF_PESSOAL`, e ignora a coluna extra.

> **Regra que sai daqui:** quem recadastra uma Sentença no RM tem de commitar o
> `.sql` no mesmo dia. O único jeito barato de conferir é rodar
> `./exportar-sentencas.sh` — ele compara os dois lados e nomeia quem divergiu.

### Volume observado em 11/09/2026 (`CODPERLET=2026`, todas as filiais)

Registro histórico, **não** referência de comparação: a base é um sistema vivo e
estes números envelhecem sozinhos (em 16/09, depois do reset, a `TODDLE.NOTAS`
devolvia 11.765 em vez de 7.283 — a base cresceu, nada quebrou). O que o código
verifica é o invariante que não caduca: **mais que zero linha**. Zero com a
Sentença cadastrada é que é sintoma — ela existe, o dado não.

| Sentença | linhas |
|---|---|
| `TODDLE.STUDENTS` | 597 |
| `TODDLE.TURMADISC` | 672 |
| `TODDLE.RESP` | 594 |
| `TODDLE.NOTAS` | 7.283 |

## Onde a Sentença mora, e por que a cópia de base a apaga

Sentença é **dado**, não configuração de servidor: mora em `GCONSSQL` (corpo,
título, flags) e `GCONSSQLPARAMETROS` (nome, descrição e tipo de cada
parâmetro), com chave `CODCOLIGADA + APLICACAO + CODSENTENCA` — aqui
`1 + S + TODDLE.*`. Copiar a base de produção por cima do dev leva as duas
tabelas junto, e é por isso que as seis somem. Não é acidente nem permissão
perdida: é a tabela sendo substituída.

### Como ler as Sentenças pela API — e por que não pela mensagem de erro

Existe um DataServer para isso, achado em 11/09/2026: **`GlbConsSQLData`**,
no mesmo `wsDataServer` da porta 1951. Ele expõe `GConsSql` (corpo e metadados)
e `GConsSqlParams` (parâmetros). `ReadRecord` com a chave `1;S;TODDLE.STUDENTS`
devolve o registro inteiro. É o que o `exportar-sentencas.sh` usa.

**Não use a sonda de erro para extrair o corpo.** Chamar com o número errado de
parâmetros faz o RM vazar o SQL (útil para saber se a Sentença existe — ver
abaixo), mas o que ele vaza é a forma **normalizada**, com os parâmetros
reescritos como `@NOME`. O corpo real, com `:NOME`, só vem pelo `ReadRecord` —
e é o corpo real que se cola de volta. Colar o vazamento reintroduz exatamente
o erro de sintaxe que o topo deste arquivo manda evitar.

Medido em 11/09: as seis armazenam `:NOME`; nenhuma armazena `@NOME`.

### Dá para recadastrar automaticamente? SIM — medido em 16/09/2026

> **Esta seção dizia "em tese sim, e não vale a pena".** Estava errada na
> conclusão e certa no motivo. O conselho de LLMs de 11/09 recomendou não usar
> `SaveRecord` como primeira opção porque o modo de falha desta casa é o serviço
> **aceitar e o dado ficar sutilmente errado**. Isso continua verdade. O que
> mudou é que o remédio para esse risco — conferir de verdade depois de gravar —
> é barato, e agora existe. O que não vale a pena é gravar SEM conferir.

`GlbConsSQLData` expõe `SaveRecord` e `DeleteRecord`. Sondado numa Sentença
descartável (`TODDLE.SONDA`, apagada em seguida):

| passo | resultado |
|---|---|
| `SaveRecord` com dataset `GlbConsSql` | gravou, devolveu `1;S;TODDLE.SONDA` |
| `GUID`, `CONTROLE`, `DTULTALTERACAO`, `USRULTALTERACAO` | **o RM gera** — não mande os do manifesto |
| `ReadRecord` de volta | corpo, metadados e parâmetros idênticos ao enviado |
| `RealizarConsultaSQL` com a credencial da integração | executou e devolveu a coluna esperada |
| `DeleteRecord` | apagou |

As seis foram restauradas por esse caminho em **16/09/2026**, depois do reset da
base. Estado conferido nas três camadas: corpo idêntico, execução sem recusa e
linhas > 0 — `STUDENTS 603`, `TURMADISC 708`, `RESP 597`, `NOTAS 11.765`,
`FREQ 800` e `PLANOAULA 1.569` (as duas últimas em janela de 7 dias).

**`DeleteRecord` quer a chave dentro de `<tot:XML>`, não em `<tot:PrimaryKey>`.**
Passar `PrimaryKey` devolve *"Falha ao salvar XML, XML invalido."* — mensagem que
não tem relação com a causa e leva a concluir que o DataServer não apaga.

#### Três coisas que só apareceram gravando

1. **`TAMANHO` conta o corpo em CRLF, e o do manifesto não é confiável.** Quatro
   das seis batem com `len(corpo com CRLF)`; `TODDLE.NOTAS` diverge em 168 e
   `TODDLE.FREQ` em 2, porque o `exportar-sentencas.sh` compara os `.sql` sem
   sensibilidade a espaço (`split()`) e não reescreve arquivo que mudou só na
   indentação. Quem grava tem de **calcular** o `TAMANHO` do corpo que está
   enviando: um número que não corresponde ao texto é o que trunca o SQL.
2. **O conteúdo de um campo vem escapado DUAS vezes.** O envelope carrega o
   dataset escapado, e dentro dele o SQL está escapado de novo. Desfazer só uma
   camada faz `F.DATA >= ...` voltar como `F.DATA &gt;= ...`, e a conferência
   reprova uma Sentença perfeita. O `exportar-sentencas.sh` sempre chamou
   `html.unescape` duas vezes — a linha passa despercebida.
3. **Coluna nula não aparece no XML do .NET.** Conferir as colunas por
   `linhas[0]` acusa "coluna removida" para toda coluna que por acaso é nula no
   primeiro registro. A união de TODAS as linhas resolve a maior parte, mas não
   distingue "removida pela segurança" de "nula em todas as linhas": a API não
   devolve schema. Quem decide a causa é comparar `SEMSEGCOLUNAS` e
   `SEMSEGESTENDIDA` com o manifesto, que é determinístico.

#### O botão no Plano de Controle

A aba **Sentenças** mostra o estado das seis e carrega as que faltam.

- `GET /sentencas` — abre lendo só o **cadastro** (corpo + flags). É barato;
  executar as seis roda a `TODDLE.NOTAS`, ~12 mil linhas por SOAP.
- `POST /sentencas/conferir` — as três camadas, sem gravar. É o passo 2 do
  runbook abaixo, e o que faltava nas duas perdas.
- `POST /sentencas/restaurar` (`tenant_admin`) — **pausa as filas**, grava só o
  que não confere, relê, e retoma as filas no fim. Idempotente por conferência,
  não por flag: o que já confere não é reenviado.

Uma fila que fique pausada não dá erro em lugar nenhum — ela só para de
processar. Por isso o `GET` devolve `filasPausadas` e a tela mostra em vermelho.

**A ordem recomendada** continua a mesma, com o passo 5 promovido:

1. **Exportar antes da cópia** (`--gravar`) — leitura pura, risco zero.
2. **Executar depois da cópia** — pelo botão *Executar as seis*. Foi a
   ausência disto que transformou a perda em dias, não a ausência do recadastro.
3. **Carregar pelo botão** — grava e prova, na mesma ação.
4. **Recadastrar à mão pela tela do RM** — continua valendo como recurso quando
   a API estiver fora, com o manifesto ao lado.

Todos os campos do manifesto seguem em `sentencas.manifesto.json`, escrito pelo
`./exportar-sentencas.sh --gravar`.

> Nem tudo que o conselho disse resistiu à conferência. O Nemotron apontou
> tabelas `GSECSENTENCA` / `GSECUSUARIOSENTENCA` para permissão: **nenhuma das
> duas existe** nas 8.521 tabelas do dicionário do RM. Também afirmou que
> `TIPO` é um enum `smallint` (seria `12` para texto) — o que se lê é
> `System.Int16`, nome de tipo .NET. Confira antes de agir.
## A cópia renumera o IDTURMADISC — e o de-para de COURSE depende dele

Decidido em 11/09/2026: a cópia vem da **produção** e o agendamento **fica
ligado**. Isso torna um detalhe do `id_mapping` a coisa mais perigosa da
operação.

O `id_mapping` foi desenhado com `rm_code` = **código de negócio** (RA, CHAPA,
CODTURMA), justamente para sobreviver a cópia de base. Duas entidades fogem
disso:

- **`COURSE`** → `rm_code` é o `IDTURMADISC` (`rmTeacherSource.ts`)
- **`ASSESSMENT`** → chave composta `IDTURMADISC:CODETAPA:CODPROVA`
  (`mappingProposalRepository.ts`)

`IDTURMADISC` é coluna *identity*. A cópia de produção **renumera**. As linhas
de `COURSE` no `id_mapping` continuam com os números antigos, e aí há dois
desfechos — o segundo é o ruim:

1. o número antigo não existe mais → a turma parece nova e o sync cria
   duplicata no Toddle. Barulhento, dá para ver.
2. o número antigo passou a pertencer a **outra** turma-disciplina → o de-para
   aponta para a disciplina errada, sem erro nenhum, e frequência e nota vão
   para a turma errada. Silencioso.

Com o cron em `0 3,9,12,16 * * *`, a primeira passada depois da cópia acontece
sozinha, sem ninguém olhando.

**O que existe para reconstruir:** `de-para-idturmadisc-20260911.csv` — as 392
turma-disciplina distintas de hoje, com `ID_TURMADISC → COD_TURMA + CODDISC +
CODFILIAL + CODPERLET`. Só chave de negócio, sem nome nem e-mail de ninguém.
Depois da cópia, rode a `TODDLE.TURMADISC` de novo e case por
`(COD_TURMA, CODDISC)` para descobrir o `IDTURMADISC` novo de cada uma, e então
corrija o `id_mapping` antes de deixar qualquer job escrever.

> O conserto de fundo é migrar o `rm_code` de `COURSE` para a chave natural
> `CODTURMA:CODDISC`, como as outras entidades já fazem. Enquanto isso não
> acontece, toda cópia de base exige esta conferência à mão.

## Recorte de campus (`RM_CODFILIAL=2`)

| Sentença | total | campus 2 |
|---|---|---|
| STUDENTS | 597 | 299 linhas / **296 RA** |
| TURMADISC | 672 | 304 |
| RESP | 594 | 296 — cobertura **integral** do roster |
| FREQ (fev) | 2.455 | 940 |
| NOTAS | 7.268 | 4.428 |

## Como diagnosticar quando uma para de responder

O RM **não** distingue "Sentença não existe" de "usuário sem permissão" — as duas
dão *"a consulta SQL utilizando a chave 1|S|X não existe ou não pôde ser executada
por restrição de filtro por perfil/usuário"*, idêntico ao de um código inventado.

**Sonda de existência:** chame com o número ERRADO de parâmetros. Se existe, o RM
responde *"Quantidade de parâmetros passados para o SQL não corresponde ao
esperado"* — e essa mensagem **vaza o corpo do SQL cadastrado**, que é como se
descobriu, em 20/08, que a `TODDLE.RESP` tinha sido cadastrada com o SQL da
`TODDLE.FREQ` colado por engano.

Para separar "conta quebrada" de "Sentença faltando", sonde um DataServer:
`GetSchema` de `EduFrequenciaDiariaWSData` responde com a mesma credencial.

### Desde 23/09/2026 essa sonda roda sozinha

O `wsConsultaSqlClient` reconhece essa recusa e chama o `autoRestauro`, que faz
exatamente o que a seção acima manda fazer à mão: lê o cadastro por OUTRO
serviço (`ReadRecord` no `GlbConsSQLData`) antes de concluir qualquer coisa.

- **Ausente** → recoloca a partir do `.sql` do repositório, confere pelas três
  camadas e repete a consulta uma vez. O job segue como se nada tivesse
  acontecido — e um alerta avisa que sumiu, porque Sentença que some significa
  cópia de base, e o resto do ambiente provavelmente mudou junto.
- **Presente** → **não escreve nada** e falha dizendo que a recusa é de
  permissão/perfil. Sobrescrever cadastro existente continua sendo decisão
  humana, no botão do painel: o RM pode estar à frente do repositório, e
  "restaurar" seria rebaixar um SQL melhor por um pior sem ninguém ver.

Desligável com `SENTENCAS_AUTO_RESTAURO=false`. A trilha fica em `audit_event`
como `sentenca.restauro.automatico`, com ator `worker:restauro-automatico`.

## Por que a Sentença de alunos traz curso e matriz

Sem saber a qual **currículo** o aluno pertence, o de-para turma
→ year group é palpite. A EAV tem dois programas com escadas de série
sobrepostas — conferido em `GET /year-groups` por currículo:

- **IB_MYP** (Middle Year Programme): 5 degraus, `Year 1`…`Year 5`
- **UBD** (Independent Programme): 15 degraus, `Pre-K`, `K1`, `K2`, `Year 1`,
  `Grade 2`…`Grade 12`

O 10º ano existe nos dois: `Grade 10` no UBD e `Year 5` no MYP. Os nomes de
coorte também colidem — há dois `Batch of 2028` e dois `Year 1`, com ids
diferentes. Sem saber o curso do aluno, não há critério para escolher.

A Sentença resolve trazendo `SHABILITACAOFILIAL` ("Matriz Aplicada") por
`SMATRICPL.IDHABILITACAOFILIAL`: `CODCURSO`, `NOME_CURSO`, `CODHABILITACAO`,
`NOME_HABILITACAO` e `ID_MATRIZ`. O de-para passa a ser
`(curso, série) → year group`, determinado pelo dado.

O middleware já lê essas colunas (`rmStudentSource.ts` → `CourseCode`,
`CourseName`, `AppliedMatrixId`). Os apelidos antigos continuam todos presentes, então a troca nao quebrou nada.

A Sentença **não traz** `PERIODO_SERIE`. Motivo: no retorno completo ela vem
preenchida **só nas matrículas canceladas** (`CODSTATUS 17`) e vazia nas
ativas — como fallback de série daria valor apenas para aluno inativo.

## TODDLE.TURMADISC

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
- O e-mail tem **três** origens, nesta ordem: `PPESSOA.EMAIL`
  (`EMAIL_PROFESSOR`), `PPESSOA.EMAILPESSOAL` (`EMAIL_PROF_PESSOAL`) e
  `GUSUARIO.EMAIL` (`EMAIL_PROF_USUARIO`). A terceira entrou em 25/08/2026
  porque cinco professores apareciam sem e-mail mesmo depois de a secretaria
  cadastrar — ver `8b08e89`. Quem lê as três é o `rmTeacherSource.ts` da branch
  `refactor/config-por-tenant`; a `main` ainda só lê as duas primeiras.

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
