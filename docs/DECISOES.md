# Decisões de arquitetura

Registro das decisões que mudam o desenho, com data e razão. Cada uma foi tomada
pela escola, não pela implementação — e várias **contradizem** o que documentos
anteriores recomendavam. Quando houver conflito, **este arquivo vence**, e o
documento antigo deve ser corrigido.

---

## D1 — A direção é Toddle → RM para nota e frequência

**06/08/2026.** Decisão da escola, textual:

> "frequência fica no toddle, e vai para o totvs, os professores vão usar o toddle,
> então notas, frequência tudo tem q ir do toddle para tovs"

### O que isso inverte

Documentos anteriores — incluindo `rm-sentencas/TODDLE.FREQ.ESPEC.md` e o conselho
técnico de 05/08 — recomendavam **RM → Toddle**, porque o TOTVS era a fonte de
verdade de fato: 21.300 ausências e ~10 mil notas lançadas à mão, contra zero no
Toddle.

Aquele raciocínio estava correto **para o estado de então**. A decisão muda o
estado: os professores passam a lançar no Toddle, e o TOTVS deixa de ser origem
para virar destino.

### O que isso destrava

**`POST /public/v2/attendance` deixou de ser bloqueio.** Ele recusa com
`"Attendance Record is not valid"` e eu o tratava como a parede central da via de
volta. Se o professor lança **pela interface**, ninguém precisa daquele endpoint: a
chamada nasce na tela e é lida pelo `GET /attendance`, que funciona.

Aquele `POST` só servia para fabricar dado de teste. **Não é caminho de produção**,
e qualquer documento que o descreva como bloqueador está desatualizado.

**A política de remoção de falta passa a funcionar.** A regra do conselho — *"só
remove automaticamente se a integração criou a ausência e nenhum ator do RM a tocou
depois"* — hoje bloqueia tudo, porque 100% das faltas são humanas. Com o Toddle
como origem, as faltas novas nascem com `CRIADO_POR` = usuário de integração, e a
regra deixa de travar a operação e passa a proteger só o histórico.

### O que isso exige, e ainda não existe

1. **Uma data de corte declarada.** A partir de quando o Toddle é a origem. Tudo
   antes fica **só no RM** — e não é escolha: as matrículas no Toddle nasceram em
   agosto/2026, e a API recusa data anterior com *"The student is not enrolled on
   the given date"*. Sem a data declarada, alguém vai olhar o Toddle vazio em março
   e concluir que o aluno não faltou.
2. **Os professores usando o Toddle de fato.** Enquanto ninguém lançar, não há o
   que sincronizar, e o shadow mode devolve zero corretamente.
3. **Política dos códigos de chamada** — como atraso e falta justificada viram
   `PRESENCA` + `JUSTIFICADA` + `IDJUSTIFICATIVAFALTA`. Hoje o que não é
   presente/ausente é recusado.
4. **Política de homeroom** — 49% da chamada existente no Toddle vem sem
   `courseId`, e sem curso não existe `IDTURMADISC`.

---

## D2 — De-para de etapa por ordinal (etapa 1 → T1)

**06/08/2026.** As janelas não correspondem:

```
Toddle T1  21/11/2025 → 22/06/2026     RM etapa 1  03/02 → 15/05
Toddle T2  23/06      → 22/09/2026     RM etapa 2  18/05 → 04/09
Toddle T3  23/09      → 20/11/2026     RM etapa 3  09/09 → 11/12
```

Gravado em `id_mapping` tipo `GRADING_PERIOD` (migração 008).

### ESTE ITEM MUDOU DE GRAVIDADE COM A D1

Quando o fluxo era RM → Toddle, o ordinal era cosmético: a nota caía na coluna
certa e a tela mostrava uma janela estranha ao lado.

**Com a D1, ele produz lançamento errado.** É o `gradingPeriodId` que determina o
`CODETAPA` no RM. Uma nota lançada em junho cai no T1 do Toddle e viraria **etapa
1** no RM, quando é 2º trimestre.

**Consequência:** corrigir as datas dos grading periods no portal virou
**requisito**, não melhoria. Enquanto não for corrigido, a via de nota
Toddle → RM não deve ser ligada.

---

## D3 — Só o responsável acadêmico vira parent no Toddle

**05/08/2026.** Criar parent **dá acesso ao LMS** — a pessoa vê nota, frequência e
comunicado dos filhos.

O lado financeiro contém pessoa jurídica: `bomaluno@institutoponte.org.br`
(Instituto Ponte) é responsável financeiro de **8 alunos de 7 famílias**. A escola
confirmou que o dado está correto — é um instituto de bolsa. Dar a ele visão do
boletim de 8 crianças é decisão que ninguém tomou, então o padrão é não incluir.

O corte não perdeu ninguém: 219 parents criados, 252 vínculos, 252 de 253 alunos
cobertos. Os 8 alunos de bolsa seguem cobertos, cada um pela própria mãe.

Efeito colateral bom: eliminou as 5 colisões de e-mail, que eram casais em que um
lado era acadêmico e o outro financeiro.

---

## D4 — Pre-K a Grade 5 estão fora de escopo

**05/08/2026.** Só campus 2 (aeroporto), Fund. II e Médio — as 185 (hoje 186)
turma-disciplina são MS e HS.

Consequência aceita: a routine `ENC` do currículo cobre as 15 séries, e ligar a
grade de horário nela alcança também Pre-K a Grade 5. No dado é inerte — elas não
têm turma nem slot no sync.

---

## Calendário — o que foi medido, e o que falta

### Não há rota de escrita na API

Testado em 06/08/2026 com **13 variantes** (`PUT`/`POST`/`PATCH`, singular e
plural, com e sem id, corpo vazio e corpo plausível). **Todas devolveram
`Route Not Found`.**

```
academic-years   PUT · POST · PATCH · singular · coleção     nenhuma existe
grading-periods  PUT · POST · singular · coleção             nenhuma existe
```

Contraste com o que a API deixa editar: período de aula, routine, bell schedule,
turma, aluno e staff todos têm escrita. Ano acadêmico e grading period são
estrutura fundacional — só pelo portal.

### O portal PERMITE editar

Confirmado pela escola em 06/08/2026: o ano **26/27** foi editado com sucesso
(passou a `2026-11-21 → 2027-12-11`).

**RESOLVIDO em 06/08/2026: o ano CORRENTE não é editável.** A escola tentou e o
portal não permitiu. Só anos futuros (o 26/27 foi editado com sucesso).

Faz sentido como restrição do produto — mover datas de ano em uso deslocaria
boletim e frequência já registrados.

### Consequência para PRODUÇÃO — requisito de onboarding

Se o ano corrente não pode ser editado, **a organização de produção tem de nascer
com o calendário certo**. Não se corrige depois de matricular aluno e lançar nota.

Para o white-label isso é item obrigatório de checklist em cada escola nova:

> **Antes de criar qualquer aluno, turma ou nota, conferir no portal do Toddle:
> a vigência do ano acadêmico e as datas dos grading periods, contra o ano letivo
> do RM.** Errar ali é permanente; só o suporte do Toddle desfaz.

Aqui é sandbox, então o custo é baixo — mas o de-para de etapa fica torto até
novembro/2026, e isso tem janelas exatas (abaixo).

### Onde o ordinal acerta e onde erra — janelas exatas

O ordinal não está errado o ano inteiro. Comparando etapa do RM com o grading
period que a contém:

```
03/02 → 15/05    etapa 1 do RM  ⊂  T1        ✓ seguro
18/05 → 22/06    etapa 2 do RM  ⊂  T1        ✗ mapearia para etapa 1
23/06 → 04/09    etapa 2 do RM  ⊂  T2        ✓ seguro
09/09 → 22/09    etapa 3 do RM  ⊂  T2        ✗ mapearia para etapa 2
23/09 → 20/11    etapa 3 do RM  ⊂  T3        ✓ seguro
21/11 → 11/12    etapa 3 do RM      sem T    ✗ sem cobertura no Toddle
```

**Três janelas problemáticas**, não o ano todo. Consequência para a implementação da
via de nota: em vez de bloquear tudo, ela pode **recusar por janela** — nota cujo
`gradingPeriodId` e data caiam numa faixa incompatível vira pendência, não
lançamento. Isso é implementável e preciso.

**A frequência não é afetada.** Ela resolve por data da aula e `IDHORARIOTURMA`, não
por período — o único problema dela é 21/11 → 11/12, que não tem timetable slot.

### O que o RM espera

```
ano      2026-02-03 → 2026-12-11
etapa 1  2026-02-03 → 2026-05-15
etapa 2  2026-05-18 → 2026-09-04
etapa 3  2026-09-09 → 2026-12-11
```

### Duas consequências se o corrente for editado

**Os 522 timetable slots foram criados com `applicableTill` limitado a 20/11** —
foi a própria API que exigiu, recusando data fora do ano acadêmico. Se o ano se
estender a 11/12, os slots continuam parando em novembro e as três semanas de
dezembro seguem sem grade. Recriá-los exige cuidado: **slot não tem `DELETE`**.

**Existem 112.489 registros de frequência de demonstração** ancorados no calendário
atual. Frequência não tem arquivamento, então mudar datas com eles presentes pode
produzir efeito estranho.

### Se o corrente NÃO for editável

A via Toddle → RM começaria com calendário torto até novembro/2026, com duas
ressalvas: as três semanas de dezembro sem grade, e nota de junho caindo em etapa
errada (ver D2).

**Recomendação:** nesse caso, **não ligar a via de nota antes do ano letivo novo**.
Melhor esperar do que sujar registro acadêmico legal com etapa errada. Frequência
pode começar antes, porque ela é resolvida por data da aula e não por período.

---

## D5 — Turma "Gerenciada" (`IG`) não existe no Toddle

**11/08/2026.** Explicação da escola, textual:

> "IG é de turma Gerenciada. No portal atual do professor ela é usada pq o mesmo
> professor dá uma disciplina para alunos que são da turma A e da Turma B, dessa
> forma, ele lança os dados de duas turmas em uma única. Dito isso, não tem
> necessidade de existir no toddle."

É **agregação de interface do RM**, não aula. O Toddle já modela isso: as turmas
reais A e B existem lá, e o professor está vinculado às duas.

### O que isso corrige

Havia 16 turma-disciplina reportadas como `TURMA_NAO_MAPEADA` — "lacuna de turma",
o item que eu recomendei como prioridade. **Era falso positivo inteiro.** Medido
antes de escrever qualquer código:

| verificação | resultado |
|---|---|
| alunos matriculados nas 16 | **0** |
| notas | **0** |
| frequência | **0** (contra 174 turma-disciplina que têm) |
| `TeacherCourse` disponível (dava para criar) | 16 de 16 |
| professor alocado **só** na gerenciada | **0 de 16** |

A última linha é a que importava: se algum professor existisse apenas na
gerenciada, ele ficaria invisível nas turmas reais do Toddle. Não é o caso — a
alocação é duplicada no RM.

**Criar as 16 teria sido erro irreversível:** turma no Toddle não tem `DELETE`, só
`archive`, e seriam 16 turmas vazias permanentes na interface dos professores.

### Como está implementado

`RM_TURMAS_IGNORADAS` (regex sobre `COD_TURMA`, na EAV `IG$`). **Sem default de
propósito**: vazio = nada ignorado, e as turmas voltam a aparecer como deriva —
correto para quem não tem essa convenção. Cravar `IG` no código seria enfiar regra
de uma escola no núcleo white label.

A turma é **marcada**, não descartada: descartar faria a contagem mentir e
eliminaria a checagem `PROF_SO_NA_GERENCIADA`, que é a única defesa contra
professor invisível.

## Quanto o dado do RM muda de fato — medido em 10/08/2026

Antes de considerar near-real-time, medi os `RECMODIFIEDON` do próprio RM.
Alterações por dia útil, fev–jun/2026 (período letivo, amostra justa — medir o
presente daria resposta enviesada, porque nada mudou desde 22/07):

| entidade | por dia útil | última alteração |
|---|---|---|
| aluno | **1,0** | 21/07 |
| turma-disciplina | **0,6** | 28/05 |
| professor | **0,4** | 01/06 |
| matrícula | 56,1 | 22/07 |

**São 2 alterações por dia útil** nas três entidades que sincronizamos. A matrícula
não conta: nada alimenta vínculo aluno↔turma hoje (o único `addStudentsToClass` do
código está num script one-shot), o sync de aluno não reenvia `yearGroupId` de
propósito, e o perfil horário delata lote do próprio RM — 3.141 alterações à
meia-noite, picos de 6.237 às 9h.

**Conclusão: near-real-time é solução para um problema que não existe.** Trocaria
24h de latência por minutos, para 2 registros/dia, ao custo de cursor, hash de
payload, ordenação de dependência e ~2.300 chamadas diárias ao RM.

Uma ressalva de honestidade: a primeira versão desta seção pesava "carga no ERP de
**produção** da escola". **O RM aqui é sandbox** (ver "Ambiente", no README), então
esse argumento não vale. O que sustenta a conclusão sozinho é a complexidade
acrescentada para 2 registros por dia — e, num RM de produção de verdade, também a
propagação de erro em minutos em vez de horas, porque hoje um lançamento errado tem
até as 3h para ser corrigido antes de sair.

**Recomendação:** se quiser menos latência, subir o batch para 2–4× por dia
(03:00 / 12:00 / 18:00). Pega o ganho percebido com uma linha de configuração.

O caminho incremental fica **provado e não implementado**: `wsDataServer.readView`
aceita filtro `RECMODIFIEDON >` server-side, testado com controle (217 / 75 / 12 / 0
registros para cortes de 2025-01-01 / 2026-01-01 / 2026-05-01 / 2026-08-01). As
Sentenças do `wsConsultaSQL` NÃO trazem coluna de auditoria — só o DataServer.

Quando os professores começarem a lançar no Toddle pela D1, o volume muda e isto
deve ser reavaliado.

## Rate limit do Toddle — janela de 300s

A coleção oficial não documenta os limites. A resposta 429 documenta:

```
"User requests rate limit is reached, please try again after 300 seconds"
```

**Isto já era conhecido** — foi medido no trabalho dos timetable slots, e
`syncResponsaveis.ts` já trazia o `comPaciencia()`, que detecta o rate limit,
**extrai os segundos da própria mensagem** e dorme esse tempo (até 3 tentativas).
Promovido em 10/08 para `packages/integrations` como `comPaciencia`, porque cada
script estava a um passo de reinventá-lo — e a primeira versão de
`reconciliar:professores` estourou o limite justamente por não tê-lo.

Três coisas que decorrem, e valem para qualquer script novo:

1. **O `withRetry` do cliente NÃO cobre isto**, de propósito. Ele faz backoff de
   ~15s no máximo, contra uma janela de 300s. A espera longa fica no `comPaciencia`
   e é **opt-in**: um cliente que dormisse 5 minutos em silêncio contaminaria o
   sync de aluno e o shadow mode.
2. **Os 300s vêm só na MENSAGEM, não em header `Retry-After`.** Daí a regex —
   é feio e é o único caminho.
3. **Pedir menos vence esperar mais.** A reconciliação de professor fazia um
   `GET /courses/:id/staffs` por turma (186 chamadas, estourou) e passou a usar
   `GET /enrollments` (cursor, 400/página): ~14 chamadas para 5.555 vínculos.
   Os dois métodos deram resultado idêntico.

Script solto **não** passa pelo limiter de 2 req/s: aquele vive na configuração do
worker BullMQ.

## Pendências que não são de código

| item | quem resolve |
|---|---|
| Data de corte da D1 | escola |
| `ETAPA_LIBERADA='N'` em 100% — a flag é gerenciada ou morta? 3.630 notas presas | escola |
| Datas dos grading periods no portal (requisito da D2) | admin do Toddle |
| ~~Ano corrente é editável?~~ **NÃO** — resolvido 06/08; ver acima. Em produção, calendário certo na criação | — |
| Política de atraso / falta justificada | escola |
| Política de homeroom (49% sem `courseId`) | escola |
| `JUSTIFICADA` vazio em 21.300 linhas — ninguém justifica? | secretaria |
| Nada lançado depois de 01/07, com 2º trimestre até 04/09 | secretaria |
| `RA 202600107` — responsável sem e-mail | secretaria |
| `IDTURMADISC 1256` (EAVHS11IA/Matemática) — etapa 1 até 10/07, sobrepõe a 2 | coordenação |
| 07–08/09 sem etapa que os cubra — emenda de feriado? | coordenação |
| 109 `academicCourseId` no portal | admin do Toddle |
| `POST /attendance` recusa — ticket, se algum dia precisar escrever no Toddle | Toddle |

## Dívidas técnicas conhecidas

**Chave do `PERIOD` sem campus.** `rm_code` é o sufixo do `CODHOR` (`001`..`007`),
que só é 1:1 com a hora no campus 2. No campus 1 a mesma faixa cobre até três
horários, e a faixa `009` de lá tem a mesma hora da `001` daqui. Inofensivo hoje,
silenciosamente errado no primeiro cliente com dois campi. A chave tem de ser a
hora por campus, ou o `CODHOR` inteiro.

**Só o fluxo de alunos é automatizado.** Corrigido em 06/08/2026 — antes disso não
havia nenhum job repetível no Redis nem supervisão.

Hoje: o scheduler `students-sync-nightly` está registrado (`0 3 * * *`,
America/Sao_Paulo) e o worker roda sob launchd
(`~/Library/LaunchAgents/com.escolaamericana.rm-toddle.worker-students.plist`,
`KeepAlive` + `RunAtLoad`, log em `logs/worker-students.log`). Verificado:
`SIGKILL` no processo → recriado em 30s (`ThrottleInterval`); `SIGTERM` fecha o
lote em andamento antes de sair; e o extract roda com o jobId no formato do
scheduler (`repeat:<nome>:<millis>`), não só com id numérico.

### O primeiro disparo real falhou — e a lição

07/08/2026, 03:00. As 3 tentativas morreram em `"Custom Id cannot contain :"` e o
job foi para a DLQ. O `runId` do fan-out vinha de `job.id`, e o id do scheduler
tem `:`; o BullMQ só aceita `:` em custom jobId quando o id quebra em exatamente
3 partes. O caminho manual passava **por sorte** (`run-36:students:0` = 3 partes),
o do cron gerava 5. Corrigido: `runId` normalizado e `-` como separador do lote —
o que também protege contra o aperto da checagem que o próprio BullMQ já marcou
como TODO.

**A lição vale mais que o bug:** o teste que eu fiz antes de ligar usou o *payload*
do cron (`trigger: 'cron'`) mas o *id* do disparo manual, e por isso passou.
Automatizar um caminho exige exercitá-lo com a forma real do gatilho, não só com
os dados dele.

**O worker precisa estar de pé para o cron valer.** Quem promove o job atrasado
no BullMQ é o worker, não o Redis. Sem worker às 3h o job não se perde — ele
dispara atrasado, quando o worker voltar.

**E o agendamento vive só no Redis.** Se o Redis reiniciar sem persistência, o
scheduler desaparece e nada dá erro. Por isso o worker o re-registra no boot e em
cada reconexão (`manterAgendamentoDeAlunos`). Registrar só no boot NÃO resolveria:
quando o Redis reinicia o worker não reinicia, ele reconecta. Em produção,
ligar AOF no Redis do Coolify é a outra metade da proteção — e conferir que
`maxmemory-policy` é `noeviction`, senão o Redis descarta job em silêncio sob
pressão de memória (o próprio BullMQ avisa: `redis-connection.js:485`).

**Ressalva grande: isto está num laptop.** Eu previ que às 3h a máquina estaria
dormindo e o job atrasaria; **o log desmentiu** — disparou às 03:00:48 de 07/08,
no horário. Mas isso foi sorte de a máquina estar acordada, não garantia: numa
noite em que ela dormir, o sync roda quando acordar. Para ser agendamento de
verdade o worker tem de ir para um host que não dorme — é a lacuna que sobra para
virar produto.

**Os outros 21 comandos seguem manuais**, e a maioria por bom motivo: são cargas
one-shot ou diagnóstico, várias irreversíveis (o `PUT` da routine, os 522
timetable slots que não têm `DELETE`). Agendar esses seria errado. O que falta de
verdade é sync de professor (ver abaixo) e a via Toddle → RM, travada por
governança.

**Sem sync de professor — a DERIVA agora é detectada (10/08/2026).**
`npm run reconciliar:professores` compara RM × de-para × Toddle, só leitura. A
escrita ainda não existe.

Duas correções factuais que este arquivo trazia erradas:

- **`TEACHER_COURSE` NÃO é turma-disciplina-professor.** Os 116 registros são
  todos `serie:NN` — nós de currículo. Quem mapeia turma-disciplina é o
  **`COURSE`**, com `rm_code = ID_TURMADISC` (186 ativos), mais 12 arquivados
  numa convenção antiga por `COD_TURMA`.
- **A Sentença `TODDLE.TURMADISC` foi publicada.** A especificação dizia que sem
  ela "não há sincronização automática possível"; ela responde desde 10/08 (648
  linhas, 18 colunas) e é a única fonte que traz o PROFESSOR — o
  `EduTurmaDiscData` não traz.

**A escrita existe e rodou** (`npm run sync:professores`, 10/08/2026). Campus 2,
35 professores, 202 turma-disciplina:

| situação | antes | depois | quem resolve |
|---|---|---|---|
| OK | 31 | **32** | — |
| não mapeado, já existia no Toddle | 1 | **0** | resolvido: de-para gravado, **sem criar** |
| **vínculo ausente no Toddle** | **2** | **0** | resolvido: `1714` e `1705` vinculados |
| sem e-mail no RM | 3 | 3 | **secretaria** — `POST /staff` exige e-mail |
| turma-disciplina sem `COURSE` | 16 | 16 | sync de turma (outra feature) |
| vínculo impossível | 19 | 18 | consequência dos 3 sem e-mail |

Os vínculos ausentes só aparecem porque a reconciliação consulta o vínculo REAL,
via `GET /enrollments`. A `1714` é a mesma turma do incidente das 60 faltas: foi
criada e **o professor nunca foi vinculado** — contagem de mapeamento diria "OK".

O que o sync NÃO faz, de propósito: não cria turma, não remove vínculo (staff a
mais na turma pode ser alocação da coordenação) e não arquiva professor que saiu.
As três são decisão humana; o relatório aponta. `reconciliar:turmas` cobre turma;
professor não tem equivalente, e é aí que a Sentença `TODDLE.TURMADISC` passa a
fazer sentido, porque é ela que traz professor.

**`apps/api` sem autorização por papel.** As tabelas `membership` existem e não são
usadas. Adiado pela escola.
