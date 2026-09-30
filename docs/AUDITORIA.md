# Auditoria técnica — 29/09/2026

Auditoria somente-leitura do middleware RM ↔ Toddle. Nenhum arquivo de código foi
alterado para produzi-la.

Backup do repositório antes de qualquer trabalho:
`~/Desktop/backup-RM_Toddle_Middleware-2026-09-29-1237.tar.gz` (8,5 MB, 1626 arquivos,
com `.git`, `.env` e `docs/`; sem `node_modules` e sem `logs/`).

---

## 0. Método, e o que ele vale

Três fontes, e elas não têm o mesmo peso:

1. **Medição direta** no repositório (contagem de linhas, leitura de arquivo,
   execução de `typecheck` e da suíte). É o que vale mais, e está marcado como
   **medido**.
2. **Conselho externo** — dois modelos consultados em paralelo. **Eles não tiveram
   acesso ao código**, só ao inventário. Serve para achar ângulo cego, não para
   afirmar fato sobre o código.
3. **Verificação das afirmações do conselho** contra o código. Onde a verificação
   contradisse o conselho, está registrado — inclusive na conclusão principal deles.

### Conselho: quem respondeu

| conselheiro | resultado | motivo |
|---|---|---|
| `claude` | respondeu (18.456 caracteres) | via CLI |
| `chatgpt` | respondeu (10.512 caracteres) | via CLI, modelo default do codex |
| `gemini` | **falhou** | `503 high demand` no CLI e `GEMINI_API_KEY` ausente em ambiente, Keychain e `.env` |
| `nemotron` | **falhou** | `ReadTimeout` na NVIDIA após 3 tentativas (timeout 300s) |

**O conselho foi parcial: 2 de 4.** Isso não é detalhe de rodapé — a convergência
entre dois modelos é bem menos informativa do que entre quatro, e ambos os que
responderam receberam exatamente o mesmo inventário, o que induz convergência por
construção. Onde os dois concordaram, eu tratei como hipótese a verificar, não como
confirmação.

---

## 1. Correções ao diagnóstico de entrada

Cinco dos nove "problemas conhecidos" do plano original não se sustentam contra o
código. Registrado aqui porque o plano pedia esforço para consertar o que já está feito.

| # | Diagnóstico de entrada | O que o código diz | Veredito |
|---|---|---|---|
| 4 | "CORS wildcard `*`" | `app.ts:138-152` usa allowlist estrita de `WEB_ORIGINS` com `credentials:true`, e há comentário de 10 linhas explicando por que nunca pode virar `*` | **improcedente** |
| 3 | ".env.example sem validação central" | `packages/config/src/env.ts` tem 560 linhas de Zod com `safeParse` + `process.exit(1)` no boot | **improcedente** (o fail-fast já existe) |
| — | "tsconfig sem strict" | `strict: true` na raiz e em `apps/web` | **improcedente** |
| 1 | "app.ts 19KB, agenda.ts 26KB, studentSync 21KB" | 434 / 590 / 474 linhas | **procedente, prioridade menor** |
| 2 | ".env.example 16KB = sprawl" | 16KB é quase todo comentário explicativo por variável | **procedente em forma, não em causa** |

Confirmados e procedentes: sem ESLint/Prettier/editorconfig/husky, sem helmet, sem
rate-limit próprio, sem OpenAPI, cache em memória no health check, 33 scripts one-off.

`.env` **nunca** foi commitado — `git log --all --diff-filter=A -- .env` devolve vazio.

---

## 2. Inventário medido

35.655 linhas TS/TSX em 9 workspaces. `typecheck` passa limpo. `npm test`: **24
arquivos, 328 testes, verdes em 2,2s**.

| Workspace | Linhas | Arquivos | Arq. de teste |
|---|---:|---:|---:|
| apps/worker | 9.759 | 42 | **0** |
| packages/domain | 6.758 | 39 | 11 |
| packages/db | 5.841 | 28 | 14 |
| packages/integrations | 4.593 | 17 | 5 |
| apps/web | 3.461 | 11 | **0** |
| apps/api | 2.568 | 10 | **0** |
| packages/config | 1.622 | 14 | 3 |
| packages/queues | 969 | 12 | 3 |
| packages/contracts | 84 | 3 | 0 |

**O CI roda 4 passos:** `npm ci` → `checar:config` → `typecheck` → `npm test`.
Não roda lint (não existe), não roda build, não roda a suíte `.itest.ts` (decisão
documentada no próprio yml), não roda `npm audit`.

**Autorização — medida rota a rota, e está correta.** Das 27 rotas, 7 não têm
`exigirPapel`, todas por desenho: `/health` e `/auth/config` (públicas) e as 5 de
`/auth/*` (auto-escopadas, passam pelo hook de autenticação). **Nenhuma rota de
escrita está desprotegida.**

---

## 3. Cobertura real — o número por pacote esconde o problema

"packages têm testes" é verdade e engana. Arquivo a arquivo:

**16 dos 32 módulos de `packages/domain` não têm teste** — e são os que traduzem
entre os dois sistemas:

```
rmAttendanceSource.ts     350   rmGuardianSource.ts       259
rmAttendanceTargets.ts    346   rmStudentSource.ts        239
attendanceProjection.ts   336   rmTeacherSource.ts        217
rmGradeSource.ts          295   rmAssessmentTargets.ts    162
+ 8 menores
```

Também sem teste: `idMappingRepository.ts` (420 linhas, o coração do de-para) e
`toddleClient.ts` (1.290 linhas).

**O que tem teste é a camada certa** — `rmWriteDecision` (15 testes), `volumeGuard`,
`notaCanonica`, `chaveCourse`, `payloadHash`. A *decisão* de escrever está coberta.
O que não está coberto é a *tradução*, e é lá que mora o erro silencioso.

---

## 4. Achados por especialidade

Cada item marca a origem: **[medido]** por mim no código, **[conselho]** apontado
pelos modelos, **[verificado]** apontado pelo conselho e conferido por mim.

### 4.1 Revisão de código e qualidade

1. **[medido]** `apps/worker/src/services/` — `sincronizarNotas.ts` (673),
   `sincronizarAvaliacoes.ts` (666), `sincronizarFrequencia.ts` (623): 1.962 linhas
   nos três caminhos que escrevem nota e falta, com zero testes no app.
2. **[medido]** `apps/api/src/app.ts` (434) mistura bootstrap do Fastify, hooks,
   error handler, cache com TTL e 4 rotas de domínio (`/config`, `/mappings`,
   `/mappings/summary`, `/pendencias/year-groups`).
3. **[medido]** 33 scripts one-off em `apps/worker/src/scripts/` expostos como npm
   scripts na raiz, incluindo `escrever:notas`, `escrever:frequencia`,
   `lancar:falta` e `criar:1714`. São caminhos de escrita real no ERP a um
   `npm run` de distância, sem confirmação de ambiente.
4. **[medido]** Ausência total de ESLint: o `typecheck` pega tipo, não pega promise
   flutuante, `catch` vazio nem variável sombreada.
5. **[medido]** `apps/api/src/rotas/agenda.ts` (590) importa de 3 pacotes e toca 9
   conceitos distintos (`flow_schedule`, cron, runs, auditoria, filas, DLQ,
   schedulers, execuções em voo, pg direto).

### 4.2 Segurança e hardening

1. **[medido]** Sem `@fastify/helmet`: nenhum `X-Content-Type-Options`,
   `X-Frame-Options` ou CSP nas respostas da API.
2. **[medido]** Sem rate-limit próprio. A API trata o 429 *do Toddle*, mas não
   limita quem chama ela — incluindo as rotas que enfileiram escrita.
3. **[medido]** Validação de payload é manual dentro de cada handler; nenhuma rota
   usa schema do Fastify. `packages/contracts` existe para isso e tem 84 linhas.
4. **[medido]** CI sem `npm audit`. A cadeia inclui axios, ioredis, jose, pg, mssql,
   fast-xml-parser — tudo em caminho de transporte.
5. **[verificado]** O conselho levantou risco de credencial nos 6,3 GB de log.
   **Conferi e não procede**: `logger.ts` tem serializador de erro próprio,
   escrito exatamente porque o axios vazava `config.auth.password` e o header
   `Authorization: Basic`. O dump de `ECONNREFUSED` do ioredis traz host e porta,
   não senha. *(Nota de contexto: a senha do RM vazou em log em 21/09; o
   serializador foi corrigido, mas a credencial ainda não foi trocada — isso é
   pendência anterior a esta auditoria, não achado dela.)*

### 4.3 Performance e resiliência

1. **[medido]** **Retry infinito do ioredis sem teto** — ver seção 5, incidente ativo.
2. **[verificado]** `pgPool max: 10` (`packages/db/src/pool.ts`) compartilhado por
   API e todos os workers. O conselho apontou como risco de esgotamento; procede
   como risco, mas **não há evidência medida de contenção** — não encontrei log de
   timeout de conexão. Fica como item a instrumentar, não a consertar às cegas.
3. **[verificado]** Timeouts existem em todas as chamadas externas e são
   deliberados: Toddle 60s, `wsConsultaSQL` 120s, `wsDataServer` 300s. O de 300s é
   longo e justificado em comentário (ReadView da filial inteira). Com `attempts:3`
   e backoff 5s, um job pode ocupar um slot por ~15 min.
4. **[medido]** Backoff e DLQ **funcionam**: `attempts: 3`, backoff exponencial 5s,
   `removeOnFail` 7 dias, DLQ manual via evento `failed` com alerta por webhook.
5. **[medido]** `cacheDoToddle` (`app.ts:97`) é cache de módulo com TTL 30s.
   **Não é bug** — há comentário explicando que vivacidade do *processo* não deve
   ser compartilhada. O efeito colateral real é o `/health` poder reportar verde
   por até 30s após o Toddle cair, e o healthcheck do docker-compose confia nele.

### 4.4 Observabilidade

1. **[medido]** **Zero rotação de log e zero alerta de processo morto.** 13 dias, 6,3 GB,
   nada avisou. Ver seção 5.
2. **[conselho]** A DLQ alerta job que falhou, mas não existe sinal para "worker
   parou de consumir" nem "fila crescendo". Um worker parado é indistinguível de
   "não havia nada a sincronizar". *(Convergente com o padrão já conhecido do
   projeto: job verde resolvendo zero.)*
3. **[verificado]** `SENT_UNKNOWN` está **modelado** no `wsDataServerClient` (o
   timeout de escrita não é tratado como falha nem como sucesso) — o conselho
   elogiou corretamente. O que falta é **contador e alerta** sobre ele: cada
   ocorrência é uma escrita possivelmente aplicada no RM sem confirmação.
4. **[medido]** O error handler achata erro de terceiro em 502 — decisão correta e
   bem justificada — mas sem id de correlação propagado, um 502 na tela não leva à
   chamada SOAP que falhou.
5. **[medido]** Existe alerta por webhook (`packages/config/src/alerta.ts`) e
   heartbeat por fluxo (`heartbeat.ts`). A instrumentação existe; a cobertura dela
   é que é parcial.

### 4.5 Testes

1. **[medido]** `apps/api`, `apps/worker` e `apps/web`: **zero** arquivos de teste
   em 15.788 linhas.
2. **[medido]** `chaveNaturalRm` / `chaveNaturalDeFalta` sem teste — ver seção 6,
   é o achado principal.
3. **[medido]** `exigirPapel` tem 34 chamadas e nenhum teste. O hook CSRF idem.
4. **[medido]** `idMappingRepository.ts` (420 linhas) é o único repositório do
   `packages/db` sem `.itest.ts`.
5. **[medido]** A suíte `.itest.ts` não roda no CI. A decisão está documentada e é
   defensável; o efeito é que a única camada que exercita Postgres, migrations e a
   transação de `audit_event` só protege quem lembra de rodá-la.

### 4.6 Design de API e interface

1. **[medido]** `packages/contracts` tem 84 linhas e 2 schemas. É o pacote que
   existe para ser fonte única entre API, worker e web, e está praticamente vazio.
   **Ambos os conselheiros o apontaram como a correção de maior alavancagem** —
   resolve validação, documentação e tipos do front de uma vez.
2. **[medido]** Sem OpenAPI. `apps/web/src/api.ts` (450 linhas) reinterpreta o JSON
   à mão; os dois lados não compartilham tipo, e o typecheck passa limpo mesmo
   divergindo.
3. **[medido]** Validação manual por handler: regras divergem entre rotas irmãs sem
   que nada detecte, e o formato do erro não é uniforme.
4. **[verificado]** O conselho sugeriu que as rotas inline de `app.ts` poderiam
   estar sem `exigirPapel`. **Conferi: não estão.** As 4 de domínio têm
   `exigirPapel(['viewer'])`; só `/health` e `/auth/config` são públicas, por desenho.
5. **[conselho]** O 502 de terceiro não distingue "RM fora do ar" de "RM recusou o
   payload" — o operador não sabe se reenvia ou corrige.

### 4.7 Frontend

1. **[medido, CORRIGIDO em 29/09]** A primeira versão desta auditoria afirmou que
   `Auditoria.tsx` não tinha estado de erro e que três painéis não tinham estado de
   carregando. **Estava errado** — a heurística contava a palavra "erro" no arquivo e
   não enxergou a delegação. Reconferido painel a painel: **os 6 painéis tratam erro**,
   delegando via a prop `aoErrar` para `App.tsx`. As lacunas reais são menores e
   pontuais: `DePara.tsx` (393 linhas) **não tem estado de carregando**, e
   `Sentencas.tsx` **não tem estado de vazio**.
2. **[medido]** **Nenhuma media query no projeto inteiro.** Só `flexWrap` e um
   `maxWidth: 980` fixo. Em tela estreita não há layout previsto.
3. **[medido, refinado]** Acessibilidade: contados os elementos interativos,
   **8 dos 11 campos de formulário não têm rótulo** (`<label>`, `aria-label` ou
   `aria-labelledby`). Só `DePara.tsx` e `Jobs.tsx` têm algum. `Acessos.tsx` (2 campos),
   `Agenda.tsx` (2 campos) e `Sentencas.tsx` (1 campo) têm zero.
4. **[medido]** Sem router: um F5 no meio de uma operação devolve o operador ao
   estado inicial, e não há URL para apontar "a pendência X" num chamado.
5. **[medido]** **Design tokens já existem e são bons.** `estilos.ts` tem paleta
   proprietária da EAV, cores semânticas (`ruim`/`bom`/`atencao`), helper `comAlfa`
   para derivar fundos, e uma escolha consciente de contraste (ocre `#A67206` em vez
   do amarelo da marca, por AA). **Isto não precisa ser padronizado — já está.**
   A tarefa 3.6 do plano original está, nessa parte, resolvida.

### 4.8 CI/CD

1. **[medido]** CI não roda build da imagem: `Dockerfile` ou compose quebrado só
   aparece no deploy manual.
2. **[medido]** CI não roda lint nem `npm audit`.
3. **[medido]** **Deploy 100% manual, sem webhook.** Merge verde não sobe nada; o
   intervalo até produção depende de memória humana, e o rollback também é manual.
4. **[medido]** CI não cobre `apps/*`. Os 328 testes verdes em 2,2s comunicam uma
   segurança que não existe para rotas, autorização e processors.
5. **[medido]** Produção roda `tsx` sem compilação. A decisão está justificada no
   `Dockerfile` (os `paths` apontam para `src/index.ts` em 9 workspaces) e
   compensada com `typecheck` no build — mas significa que **o typecheck é a única
   barreira automática entre o código e o ERP da escola**, e nenhum lint roda antes.

---

## 5. Incidente ativo (fora do escopo pedido, encontrado na auditoria)

**Na máquina de desenvolvimento, não em produção.**

```
logs/worker-students.log         4,6 GB
logs/worker-students.error.log   1,7 GB
                                 ─────
                                 6,3 GB
```

Crescimento **medido agora**: +87 KB e +39 KB em 10 segundos ≈ **1 GB/dia**.

Causa: o worker sob launchd (`com.escolaamericana.rm-toddle.worker-students`,
PID 3338, no ar desde **16/09**) tenta conectar num Redis local que está fora do ar.
O `ioredis` retenta indefinidamente e cada falha despeja um `AggregateError
[ECONNREFUSED]` completo nos dois arquivos.

**13 dias. Nada alertou.** É o padrão de silêncio que este projeto persegue: um
processo falhando em laço, verde para o launchd, invisível para todo mundo.

Três defeitos distintos, e o terceiro é o que importa:
1. Sem rotação de log em `scripts/worker-students.sh` / plist.
2. Sem teto de retry de conexão no `ioredis`.
3. **Sem sinal de "worker não está consumindo"** — a DLQ só alerta job que *falhou*;
   um worker que nunca chega a pegar job não produz evento nenhum.

O dano é reversível (disco e um worker morto), mas o defeito nº 3 é o mesmo que
existe em produção.

---

## 6. A pergunta C, e onde o conselho errou

Perguntei aos dois: *qual é o único problema que, se ignorado, tem maior chance de
causar dano irreversível a dado de aluno?*

**Ambos responderam a mesma coisa:** `sincronizarFrequencia.ts` sem testes, com o
caminho de dano sendo "resposta incompleta do Toddle → o sistema infere remoção →
apaga ausência lançada por um professor".

**Verifiquei no código. A resposta deles está errada para esta base** — e errada de
um jeito instrutivo: eles raciocinaram a partir da ausência de testes, sem poder ver
que a lógica de decisão foi *extraída* daquele arquivo para um módulo puro e testado.

O que existe de fato:

- `packages/domain/src/rmWriteDecision.ts` — `decidirEscrita`, função pura com **6
  vereditos**, dos quais dois cobrem exatamente o cenário descrito:
  - `REMOCAO_PEDE_HUMANO` — *"o registro saiu do Toddle mas existe no RM. Remoção de
    falta tem efeito legal e de comunicação com a família — decisão humana, caso a caso."*
    Nunca infere `DELETE`.
  - `CONFLITO_HUMANO` — existe no RM e não é nosso: **nunca sobrescreve**.
  - E o fail-closed: autoria **desconhecida** também recusa.
- **15 testes unitários** cobrindo esses casos, incluindo *"recusa quando a autoria é
  DESCONHECIDA — fail-closed"* e *"pede humano quando saiu do Toddle mas existe no RM"*.
- `packages/domain/src/volumeGuard.ts` — `avaliarVolume`, com teto absoluto, teto de
  desvio e teto de % do escopo, chamado em `sincronizarFrequencia.ts:341`.

A mitigação que os dois recomendaram ("adicionar uma guarda de plausibilidade")
**já está implementada e testada**. Esta é a parte mais bem defendida do sistema.

### O risco real, que nenhum dos dois podia ver

A proteção depende de o cruzamento **casar a linha certa**. Ele é feito por chave
natural, montada por **uma única função chamada dos dois lados** —
`chaveNaturalRm` em `attendanceProjection.ts:106`, e `chaveNaturalDeFalta` em
`rmAttendanceSource.ts:320`, que a reusa.

O próprio autor documentou o modo de falha, em `rmAttendanceSource.ts:305-317`:

> *"Se as duas fórmulas divergirem — uma vírgula, uma ordem de campo, um `codColigada`
> como `"1"` contra `1` — o cruzamento não casa NADA. E o modo de falha é o pior
> possível: tudo aparece como `ESCREVER_NOVO`, a proteção contra sobrescrever
> lançamento humano **se desliga em silêncio**, e o relatório fica bonito."*

**Essa função não tem um único teste.** A proteção tem 15; a chave que faz a proteção
apontar para a linha certa tem zero.

E há um caminho concreto para acioná-la, que não é hipotético neste projeto:

```
chaveNaturalRm = [codColigada, idHorarioTurma, idTurmaDisc, ra, data].join('|')
```

Na leitura do RM (`rmAttendanceSource.ts:210-212`), dois desses componentes caem
para string vazia quando a coluna não vem:

```ts
idTurmaDisc:    pick(row, 'ID_TURMADISC', 'IDTURMADISC') ?? '',
idHorarioTurma: pick(row, 'ID_HORARIO_TURMA', 'IDHORARIOTURMA') ?? '',
```

Se a Sentença do RM parar de devolver uma dessas colunas — e neste projeto Sentença
**some e volta**: toda cópia de base apaga as seis (13-15/08, 16/09 e 20/09/2026), e
o restauro automático recoloca a versão do repositório, que pode estar **atrás** do
RM — então *toda* falta lida ganha um segmento vazio na chave, **nada** casa, tudo
vira `ESCREVER_NOVO`, e a proteção contra sobrescrever lançamento humano desliga
sozinha. Sem exceção, sem job vermelho, sem DLQ. Com relatório bonito.

O `?? ''` é o defeito: ele converte *"a coluna sumiu"* em *"o valor é vazio"*, quando
deveria falhar alto.

**Conclusão corrigida:** o problema de maior dano irreversível não é a ausência de
teste em `sincronizarFrequencia.ts`. É **`chaveNaturalRm`/`chaveNaturalDeFalta` sem
teste, combinada com o `?? ''` que degrada silenciosamente a chave quando a Sentença
muda** — porque é o único caminho conhecido em que *todas* as travas do sistema
continuam funcionando como projetadas e o dado do professor é destruído mesmo assim.

---

## 7. A pergunta A: migrar o CSRF?

Perguntei se trocar o hook manual por `@fastify/csrf-protection` (double-submit
cookie) é melhoria ou regressão.

**Os dois conselheiros responderam, independentemente: regressão.** Verifiquei o
raciocínio contra `app.ts:172-211` e ele procede.

O hook atual usa **`Sec-Fetch-Site`**, que é preenchido pelo navegador e **não pode
ser forjado por página web**. É a defesa mais forte disponível, e é precisamente a
que o double-submit **não** usa. Somam-se a ela a allowlist estrita de `Origin`, o
fallback comparando host de `Origin`/`Referer` com o nosso, a recusa quando faltam os
dois (falha fechada) e a isenção correta para Bearer sem cookie.

O double-submit não consulta `Sec-Fetch-Site`, não consulta allowlist de origem, e
exige um cookie de token legível por JavaScript. É notoriamente fraco contra
subdomínio comprometido — cenário em que a allowlist de `Origin` atual continuaria
bloqueando. Além disso a troca custaria: `apps/web/src/api.ts` passaria a buscar e
anexar token em toda mutação, e o fluxo Bearer precisaria de isenção explícita,
reintroduzindo dentro do plugin a mesma regra que o hook já implementa.

**Recomendação: remover a migração de CSRF do plano.** A preocupação legítima por
trás dela — código de segurança manual sem teste — se resolve testando o hook, que
custa uma fração e ataca o risco real.

---

## 8. Os 5 primeiros testes

Convergência dos dois conselheiros, ajustada pela verificação da seção 6.

| # | Onde | O que afirmar |
|---|---|---|
| 1 | `packages/domain` — `chaveNaturalRm` / `chaveNaturalDeFalta` | As duas fórmulas produzem a **mesma** chave para o mesmo fato (`codColigada` `1` vs `"1"`, data, RA, IDTURMADISC). E que componente vazio **falha alto** em vez de virar `''`. *Este é o teste que a seção 6 justifica.* |
| 2 | `apps/worker` — `sincronizarFrequencia.ts` | Teste de caracterização do delta: dado estado RM + estado Toddle, quais faltas são criadas, mantidas e recusadas. Caso obrigatório: origem vazia ou parcial **não** produz remoção. |
| 3 | `apps/api` — `exigirPapel` | Tabela papel × rota, afirmando 403 onde deve negar. Mais um teste de inventário: toda rota registrada fora de `/health` e `/auth/config` passa por `exigirPapel` — protege a rota nº 28 contra o esquecimento. |
| 4 | `apps/api` — hook CSRF | Tabela: Bearer sem cookie → passa; `Sec-Fetch-Site: cross-site` com cookie → 403; `Origin` fora da allowlist → 403; sem `Origin` nem `Referer` → 403; GET sempre passa. Congela o comportamento e torna qualquer migração futura mensurável. |
| 5 | `apps/worker` — `SENT_UNKNOWN` | Que timeout de escrita **não** vira retry cego: com `attempts: 3`, retentar um `SENT_UNKNOWN` é como a mesma nota é gravada três vezes. Deve pedir reconciliação, não repetição. |

Nenhum depende de Postgres. Todos entram no CI que já existe.

---

## 9. Ordem de ação recomendada

1. **Hoje** — matar o laço do launchd, truncar os 6,3 GB, adicionar rotação e teto de
   retry de conexão. É 1 GB/dia correndo agora.
2. **P0** — teste nº 1 (chave natural) e substituir o `?? ''` por falha alta.
   É o caminho de dano irreversível da seção 6.
3. **P0** — testes 2 a 5 no CI.
4. **P1** — preencher `packages/contracts`: destrava validação por schema, OpenAPI e
   tipos do front de uma vez. Apontado pelos dois conselheiros como maior alavancagem.
5. **P1** — ESLint + Prettier, `npm audit` no CI.
6. **P1** — helmet + rate-limit.
7. **P2** — quebrar `app.ts`, `agenda.ts` e os três `sincronizar*.ts`.
8. **P2** — frontend: estados de erro/carregando faltantes, media queries, `aria-*`.
9. **P3** — arquivar scripts one-off.
10. **Removido do plano** — migração de CSRF (seção 7).

---

## 9. A classe do acesso indexado cru — mapeada no P1-C (30/09)

### O mapa das 8 chaves inline nos caminhos de escrita

| # | local | papel | risco |
|---|---|---|---|
| 1 | `rmAssessmentTargets:102` | **produtor** — `row.IDTURMADISC` cru + `String(row.CODETAPA)` | **classe (a)** — falha ABERTA |
| 2 | `rmGradeTargets:87` | **produtor** — `` `${idTurmaDisc}|${row.CODETAPA}` `` cru | fail-safe **por acidente** |
| 3 | `rmAssessmentTargets:167` | consumidor (`provasDe`) | — |
| 4 | `rmGradeTargets:119` | consumidor | — |
| 5 | `gradeProjection:322` | consumidor do índice de (2) | — |
| 6 | `provaXml:150` | produtor a partir de dado já projetado | baixo |
| 7-8 | `sincronizarAvaliacoes:619,642` | produtores a partir de dado já projetado | baixo |

As duas produtoras cruas foram consertadas. As seis restantes recebem dado já
tipado ou são consumidoras.

### O REGISTRO CENTRAL: o consumidor do miss é o elo que ninguém auditou

Duas chaves, **mesma classe de defeito**, **consequências opostas** — e a
diferença nunca esteve escrita em lugar nenhum:

| | mecanismo | desfecho |
|---|---|---|
| **falha ABERTA** | `provasPorEtapa.get(chave) ?? []` | lista vazia → `proximoCodProva` volta 1 → guarda anti-duplicata vazia → o sistema **CRIA** uma avaliação que já existe, com `CODPROVA` colidindo |
| **fail-safe** | `ctx.etapasRm.get(chave)` sem default | `gradeProjection` recusa com `ETAPA_NAO_GRAVAVEL` → a nota não é escrita |

O segundo é fail-safe **por acidente**, não por projeto. É propriedade que
morre no dia em que um consumidor novo escrever `?? algumPadrão`.

`map.get(...) ?? []` passa a ter estatuto de **token de busca**, ao lado de
`?? ''` e `String(indexado)`. A varredura foi feita: só duas ocorrências no
repositório, e a segunda (`reconciliarTurmas:152`) é `(get ?? 0) + 1`, o idioma
correto de acumulador.

### Perfil de irreversibilidade distinto: a avaliação fantasma

Os três caminhos fechados até aqui tinham o mesmo dano — **sobrescrever** valor
lançado por professor. A chave da prova tem outro:

O sistema não altera um valor: ele **cria um registro novo** no acadêmico, uma
avaliação com `CODPROVA` colidindo com uma existente. Remover avaliação no RM é
operação manual e dolorosa; e enquanto ela existir, a média da etapa é composta
com uma prova que ninguém lançou.

### Por que a auditoria manual errou a fronteira, e o typecheck acertou

O mapa do P1-A varreu o token `?? ''` e achou 38 ocorrências. A chave da prova
não tem token: é um template literal montado inline, 15 linhas acima do ponto
que eu auditei, sem nome.

Ligar `noUncheckedIndexedAccess` — mesmo sem manter a flag — produziu a lista
que a leitura não produziria. **A lição não é "chaves são mais numerosas que as
nomeadas"** (foi a minha primeira formulação, e ela é vaga): é que
**consumidores de miss são o elo não auditado**, e que um detector mecânico
encontra o que a varredura por token não alcança.

### O que a flag NÃO pegaria

Medido: `noUncheckedIndexedAccess` dá 253 erros no repositório — e **nenhum dos
dois defeitos reais está entre eles**. `String(row.CODETAPA)` compila sob a
flag (`String` aceita `undefined`), e interpolar em template literal também.

A flag é higiene de tipos e profundidade FORA da classe que causou dano. O
detector DA classe é a regra de lint. Ver a decisão de orçamento em
`docs/PLANO.md`.
