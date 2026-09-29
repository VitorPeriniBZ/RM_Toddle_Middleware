# Pendências

Coisas encontradas durante a auditoria e a execução do P0 que **não** são
código deste repositório, ou que estão fora do escopo do item em andamento.
Registradas aqui em vez de corrigidas no meio de outra coisa.

Ver também `docs/AUDITORIA.md` (o que foi medido) e `docs/PLANO.md` (a ordem).

---

## 0. RESOLVIDO — usuário do RM foi bloqueado por mim e liberado pelo usuário

**Encerrado em 29/09. Fica registrado porque o dado operacional é útil.**

```
15:50:32  npm run canario -> as SEIS Sentenças conferem.
15:51:0x  contraprova minha com RM_WS_PASS errada: 6 auth falhas seguidas.
15:51:42  canário com a senha CORRETA -> HTTP 401 nas seis.
15:54:4x  nova tentativa após 3 min -> 401 de novo.
          [usuário desbloqueia o cadastro no RM]
          npm run canario -> as seis conferem. Confirmado.
```

**Causa confirmada pelo desfecho:** seis autenticações falhas seguidas bloquearam
o usuário da integração no RM. A senha do `.env` sempre esteve correta — provado
pela leitura bem-sucedida às 15:50:32, antes das tentativas.

**O erro de método foi meu**: para provar que o canário consegue falhar, usei
credencial errada contra um sistema real. A contraprova certa é alterar o `.sql`
local, que não toca o RM.

### O que fica como pendência real

**Quantas tentativas o RM tolera?** Não está documentado em lugar nenhum deste
repositório, e agora sabe-se que 6 bastam para bloquear. O canário agendado fará
**144 autenticações por dia** (uma por Sentença, de hora em hora). Se o RM
contar tentativas falhas numa janela, uma indisponibilidade parcial poderia
acumular falhas e bloquear o usuário sozinha — transformando o vigia em causa
do incidente que ele deveria observar.

Vale descobrir o limite e, se for baixo, considerar um disjuntor no canário:
após N falhas de autenticação seguidas, parar de tentar e alertar, em vez de
insistir de hora em hora.

### §0.1 O canário deveria distinguir 401 de outras falhas

Uma Sentença não verificada por **credencial recusada** é um incidente com dono
e conserto claros; por timeout é outra coisa. Hoje as duas caem em
`naoVerificadas` e produzem seis linhas idênticas quando o fato é UM: o usuário
está bloqueado.

Merece alerta próprio, com assunto estável (`Canário: o RM recusou a
credencial`), emitido uma vez — e é o lugar natural para o disjuntor acima.

Não implementado no P0-4: é achado desta sessão, não escopo do item.

---

## 0.2 `semChave > 0` deveria virar suspeita no sinal de cruzamento

O P0-6 passou a descartar a linha do RM quando um componente da chave vem vazio
(a coluna EXISTE no result set, o valor é que não veio). O contador saiu em
`ResumoLeituraFrequencia.semChave`.

**Descartar é contenção, não proteção.** Vale dizer com todas as letras porque a
tentação de achar que resolve é real: descartar a linha e manter a chave
degradada levam ao MESMO desfecho para aquela aula — a projeção não encontra
nada, responde `ESCREVER_NOVO`, e a falta lançada pelo professor é sobrescrita.

O que o descarte evita é o caso PIOR: duas linhas degradadas colidindo entre si
na mesma chave, onde uma some do índice e a outra pode casar com a aula de outro
professor.

A proteção de verdade é `semChave > 0` entrar como motivo em `avaliarCruzamento`
(P0-5): se há faltas humanas que não conseguimos enxergar, ninguém deveria
escrever por cima. Não feito no P0-6 por ser mudança no contrato do sinal, fora
do escopo do item.

---

## 1. Criar os canais de aviso — BLOQUEIA a conclusão do P0-2

**Dono: humano. O código está pronto; faltam as contas.**

O P0-2 deixou de tornar o silêncio silencioso: o processo grita no boot, o
`/health` publica o estado, e `npm run alerta:testar` prova o caminho ponta a
ponta. Nada disso substitui ter um canal para onde gritar.

### 1.1 `ALERTA_WEBHOOK_URL` — a mais importante

Cobre os dois modos de falha com o processo **vivo**: DLQ e vigia. É a única
variável que sozinha já tira o sistema da cegueira total. Se for configurar uma
coisa só, configure esta.

Qualquer um dos três serve — o corpo enviado é `{ text, content }`, que os três
aceitam sem adaptação:

| serviço | como obter |
|---|---|
| Slack | https://api.slack.com/messaging/webhooks |
| Discord | Editar canal → Integrações → Webhooks |
| ntfy | `https://ntfy.sh/<topico>` — sem cadastro |

Depois de definir, provar:

```bash
npm run alerta:testar
```

Saída `0` = o canal aceitou. **Confira se a mensagem chegou de verdade**:
aceitação não é entrega — um webhook apontando para canal arquivado responde
200 e engole a mensagem.

### 1.2 `HEARTBEAT_URL_*` — as quatro

Cobrem o modo de falha oposto: o processo **morto**. O job avisa que está vivo e
um terceiro reclama quando o aviso não chega. É o que teria pego os 8 dias de
silêncio de agosto e os 13 dias do worker do launchd.

Um monitor por fluxo, porque a falha de um não é a do outro:

| variável | fluxo | janela sem sucesso |
|---|---|---|
| `HEARTBEAT_URL_ALUNOS` | alunos | 13h |
| `HEARTBEAT_URL_PROFESSORES` | professores | 13h |
| `HEARTBEAT_URL_NOTAS` | notas | **4h** |
| `HEARTBEAT_URL_FREQUENCIA` | frequência | 13h |

Serviços: Healthchecks.io (tem plano gratuito) ou Uptime Kuma (auto-hospedado).
Protocolo: `GET <url>` = sucesso, `GET <url>/fail` = falha explícita.

**Configure as janelas no monitor externo com folga sobre os valores acima** —
são as janelas que o vigia usa internamente (`packages/queues/src/fluxos.ts`), e
um monitor mais apertado que o vigia gera alarme falso.

### 1.3 Em produção

As variáveis são do ambiente do Coolify, não do `.env` do repositório. O
`docker-compose.coolify.yml` já as documenta nos comentários (linhas 58-65).
Depois de configurar, conferir em:

- `GET /health` → `cegoParaAlertas` deve virar `false` (rota pública, um bit só)
- `GET /config` → campo `avisos` com o detalhe (exige papel `viewer`)

### 1.4 Agendar o teste sintético

Um canal que não recebe nada há sete dias é indistinguível de um canal quebrado.
`npm run alerta:testar` é barato o bastante para virar um agendamento semanal.
**Ainda não agendado.**

---

## 2. Assento do `gemini` no conselho está quebrado

**Dono: humano. Não bloqueia nada.**

Falhou nas três consultas desta auditoria, sempre pelos mesmos dois motivos
encadeados:

```
gemini-cli (rc=1): Attempt 1 failed with status 503 ... "This model is
currently experiencing high demand"
| GEMINI_API_KEY não encontrada em nenhuma fonte (ambiente, Keychain
  'conselho-gemini', .env do cwd)
```

O CLI cai por sobrecarga do tier gratuito e o fallback de API não tem chave.
Conserto:

```bash
security add-generic-password -a "$USER" -s conselho-gemini -T /usr/bin/security -w
```

É pendência de ferramenta (`~/.claude/skills/Conselho`), não deste projeto. As
consultas seguiram com 2 e 3 conselheiros, sempre declarado.

---

## 3. Corrigido durante o P0-2, registrado por ser não-óbvio

O `assunto` dos alertas do vigia carregava número variável — `nenhum run
bem-sucedido há 13.2h`. O número muda a cada 6 minutos, o vigia roda a cada 15,
e o assunto é a CHAVE da supressão. Resultado: a supressão nunca acontecia.

Isso não aparecia porque não havia canal. **No minuto em que
`ALERTA_WEBHOOK_URL` fosse configurada**, um único fluxo travado passaria a
notificar a cada 15 minutos, indefinidamente — e o canal seria silenciado no
primeiro dia, desfazendo o item inteiro.

Corrigido: assuntos estáveis (o número foi para o `contexto`, que é renderizado
no corpo) e `repetirApos: 6h` para os achados do vigia, que são condição
persistente e não evento. Achado pela pergunta de cardinalidade de um dos
conselheiros.

---

## 4. Fora do escopo, achado na auditoria

### 4.1 `logs/` com 6,3 GB na máquina de desenvolvimento

O worker sob launchd (`com.escolaamericana.rm-toddle.worker-students`) martela um
Redis local fora do ar desde 16/09, ~1 GB/dia. Sem rotação de log, sem teto de
retry de conexão no `ioredis`.

**É o item P1-2 do plano.** O truncamento dos arquivos e o `launchctl` ficam para
lá, ou para uma decisão sua antes disso — não mexi no seu processo.

### 4.2 A senha do RM ainda não foi trocada

O serializador de log que a vazava foi corrigido em 21/09
(`packages/config/src/logger.ts`, com teste). A credencial que esteve exposta
**continua em uso**. Anterior a esta auditoria; registrado por ser o tipo de
pendência que some.

### 4.3 Nenhum `trustProxy` na API

`apps/web/nginx.conf:26` define `X-Forwarded-For`, mas o Fastify não confia em
proxy. `req.ip` é o IP do container do nginx, igual para todos. Hoje não causa
dano; **causaria** no P1-5, transformando o rate-limit num balde único para a
escola inteira. Detalhado na seção 6 do `docs/PLANO.md`.

### 4.4 `/health` expõe o texto do erro a chamador anônimo

`checarDependencia` devolve `erro: texto.slice(0, 160)` da exceção, e o
`/health` — que é público — o publica. Uma queda de Postgres imprime coisas
como `connect ECONNREFUSED 10.0.1.5:5432`, que nomeia a topologia interna.

**Não corrigido de propósito**: a tela de saúde RENDERIZA esse texto
(`apps/web/src/App.tsx:364`), então removê-lo quebra o painel. O conserto certo
é mover o detalhe para uma rota autenticada e a tela passar a consumi-la — o que
é mudança de contrato com o front, fora do escopo do P0-3.

O `/health/ready`, criado no P0-3, já nasce sem esse vazamento: o tipo
`DependenciaAvaliada` só tem `nome` e `estado`, então não há de onde vazar.

### 4.5 `pgPool` sem `connectionTimeoutMillis`

`packages/db/src/pool.ts` cria o pool com `max: 10` e nada mais. Um `SELECT 1`
abandonado — pela corrida de prazo do `/health/ready`, por exemplo — segura um
client do pool, e segura justamente quando o banco já está mal.

Mitigado no P0-3 por outro caminho: o cache de prontidão garante no máximo UMA
checagem em voo, então a pressão é de 1 client, não N. O ajuste do pool em si
toca todos os consumidores (API e worker) e não cabia num PR de readiness.

Levantado por uma pergunta do conselho na revisão do P0-3, e confirmado no
código.

### 4.6 Sem enforcement da regra "teste de `apps` não faz I/O"

A suíte `unit` passou a incluir `apps/*/src/**/*.test.ts` no P0-3. A regra de
que teste com I/O é `.itest.ts` está escrita no comentário do
`vitest.workspace.ts` e **não é verificada por nada**.

O risco concreto que o conselho nomeou: um teste futuro que chame o Toddle de
verdade. O runner do CI tem saída de internet, o teste passaria, e queimaria
cota de rate limit sem ninguém ver. Um stub global de `fetch` que lança na
suíte unit resolveria — não feito aqui por ser mudança de infraestrutura de
teste, fora do escopo do P0-3.

### 4.7 `apps/worker` não declara nenhuma dependência

`apps/worker/package.json` tem `dependencies` vazio e usa `bullmq`, `ioredis` e
outros por hoisting do workspace raiz. Funciona com npm workspaces e com o
`COPY . .` do Dockerfile. É latente, não quebrado.
