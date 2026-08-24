# `EduPlanoAulaData` — a via de escrita do plano de aula no RM

Levantado em **21/08/2026**, contra o RM real. Sonda de `GetSchema` + `ReadView`;
nenhuma escrita.

## 1. O DataServer existe

```
GetSchema EduPlanoAulaData   ->  13.051 bytes, OK
```

Quatro nomes candidatos foram descartados por `Classe não encontrada`:
`EduPlanoAulaWSData`, `PlanoAulaData`, `SPlanoAulaData`, `EduPlanoDeAulaData`.

O schema expõe três tabelas: `EduPlanoAula` (vazia, wrapper), **`SPlanoAula`** (40
colunas) e `SPlanoAulaArquivo` (7 colunas — anexos, com `ARQUIVO` e `PATHARQUIVO`).

> **Case do elemento-linha:** o `ReadView` devolve `SPlanoAula`, não `SPLANOAULA`.
> O cliente avisa (`elemento-linha com case diferente do esperado`) e segue, mas
> passe `SPlanoAula` para evitar o aviso.

**A API REST do Educacional não serve.** O recurso `LessonPlan` (módulo `aluno`)
é somente GET, e neste CloudTOTVS o REST não está publicado (`TOTVS_RM_HOST`
vazio). A via é o `wsDataServer` com `SaveRecord`, igual à frequência.

## 2. As chaves são as que já resolvemos

| coluna | papel |
|---|---|
| `CODCOLIGADA` + `IDTURMADISC` + `IDPLANOAULA` | chave da linha |
| `IDHORARIOTURMA` | a aula na grade — **o mesmo alvo que `rmAttendanceTargets` já resolve** |
| `AULA`, `DATA`, `DIASEMANA`, `HORAINICIAL`/`HORAFINAL` | posição no calendário |
| `CODTURMA`, `CODDISC`, `NOMEDISC`, `CODPROF`, `CODFILIAL`, `IDPERLET` | contexto |

Isso importa mais que parece: o fluxo de plano de aula **reusa a resolução de
alvo da frequência**. `IDTURMADISC` é a chave do nosso de-para `COURSE`, e
`IDHORARIOTURMA` é o que o shadow de frequência já sabe resolver a partir de
(turma-disciplina, dia da semana, faixa de horário) — 518 chaves para 518
horários, único.

## 3. Os campos de conteúdo

| coluna | descrição no dicionário | quem escreve |
|---|---|---|
| `CONTEUDO` | "Conteúdo do Plano de Aula" | a escola — é o **previsto**/ementa |
| **`CONTEUDOEFETIVO`** | "Conteúdo efetivo da aula ministrada" | **o professor — é o nosso destino** |
| `LICAOCASA` | "Conteúdo a ser realizado em casa/extraclasse" | professor |
| `OBSERVACAO` | observação livre | professor |
| `CONFIRMADO` | confirmado | ver §5 |

A decisão da escola (ver `DECISOES.md` D6) é que o plano de aula é **do
professor, no Toddle, indo para o TOTVS**. Isso mapeia em `CONTEUDOEFETIVO`, não
em `CONTEUDO`.

## 4. ⚠️ A LINHA JÁ EXISTE — escrever é UPDATE, não INSERT

O achado que muda o desenho. `ReadView` de todo o campus 2:

| medida | valor |
|---|---|
| linhas de plano de aula | **22.367** |
| com `CONTEUDO` (previsto) preenchido | 6.365 |
| com **`CONTEUDOEFETIVO`** (ministrado) preenchido | **12.166** |
| com `LICAOCASA` | 58 |
| `CONFIRMADO` | `'N'` em **100%** |
| janela de `DATA` | 2025-09-01 a 2026-12-31 |
| chave `(IDTURMADISC, IDPLANOAULA)` | 22.367 distintas / 22.367 linhas — sem fan-out |
| turma-disciplina distintas | **202** — exatamente as do período letivo corrente |

As 22.367 linhas são **pré-criadas a partir da grade horária**, cobrindo o ano
letivo inteiro. Não criamos aula: a aula já está lá, esperando conteúdo.

**Consequência direta, e é a mais importante deste documento:** a regra de
proveniência que protege a frequência — *"só altere linha que a integração
criou"* — **não traduz para cá**. Aqui *nenhuma* linha foi criada pela
integração; todas são da escola. Aplicar a regra ao nível da LINHA bloquearia
100% das escritas; ignorá-la sobrescreveria 12.166 conteúdos escritos por
professores à mão.

A regra tem de ser **por CAMPO**:

> Escreva `CONTEUDOEFETIVO` apenas quando ele estiver **vazio**, ou quando a
> última escrita dele tiver sido da própria integração (proveniência nossa, em
> tabela local). Campo preenchido por humano e nunca tocado por nós é
> intocável — gera pendência para revisão, não sobrescrita.

E o writer nunca deve tocar `CONTEUDO` (o previsto), que pertence à coordenação.
Dono declarado por campo, imposto em código.

## 5. Duas coisas a confirmar antes da primeira escrita

1. **`CONFIRMADO = 'N'` em 100% das 22.367 linhas.** É o mesmo padrão de
   `ETAPA_LIBERADA='N'` nas notas: ou a escola não usa a confirmação, ou ela é
   parte de um fluxo que ninguém executa. Antes de escrever, saber se
   `CONFIRMADO='S'` fecha a aula para edição — se fechar, é a guarda natural de
   "não mexer em aula fechada", como a etapa é para nota.
2. **Proveniência não vem pelo DataServer.** `SPLANOAULA` tem as 4 colunas de
   auditoria (`RECCREATEDBY`, `RECCREATEDON`, `RECMODIFIEDBY`, `RECMODIFIEDON`)
   no dicionário, mas o schema do DataServer **não as expõe**. Então a leitura de
   autoria precisa de **Sentença**, igual à `TODDLE.FREQ` (que traz `CRIADO_POR`
   e `ALTERADO_POR`). Sem ela, a regra do §4 não é verificável — e cadastrar
   Sentença depende do administrador do RM, ou seja tem prazo de terceiro.

   **É a dependência de caminho crítico deste fluxo.** Descobrir isso agora, e
   não no dia da primeira escrita, é o motivo deste documento existir.

## 6. ⛔ O lado do Toddle não existe (ainda)

O destino no RM está resolvido — mas **a origem não tem superfície**. Medido em
21/08/2026: a Open API V2 do Toddle **não expõe plano de aula**. Zero menção nos
151 endpoints das duas coleções, e o servidor devolve `"Route Not Found"` para
`unit-plans`, `lesson-plans`, `units`, `lessons`, `planner`, `curriculum-units` e
para as variantes aninhadas em `/teacher-courses/:id/...` (testadas com id real).

Então este documento descreve **metade de um fluxo**. O DataServer, as chaves e a
regra por campo continuam valendo, e é bom tê-los levantados — mas nada pode ser
construído até o Toddle expor a leitura. Ver `DECISOES.md` D6, item 3, para o que
perguntar ao Toddle e a alternativa (ruim) via `assignments`.

## 7. O que NÃO fazer

- **Não criar linha de plano de aula.** A grade cria; nós preenchemos. Insert
  duplicaria aula.
- **Não escrever `CONTEUDO`.** É o previsto, e o dono é a coordenação.
- **Não apagar conteúdo.** Professor que limpa o campo no Toddle gera tarefa
  humana, não `UPDATE` para vazio — o registro de aula tem valor de diário.
- **Não confiar no `ReadView` para autoria.** Ver §5.2.
