# Pendências

Coisas encontradas durante a auditoria e a execução do P0 que **não** são
código deste repositório, ou que estão fora do escopo do item em andamento.
Registradas aqui em vez de corrigidas no meio de outra coisa.

Ver também `docs/AUDITORIA.md` (o que foi medido) e `docs/PLANO.md` (a ordem).

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
Depois de configurar, conferir em `GET /health` → campo `avisos`.

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

### 3.1 `logs/` com 6,3 GB na máquina de desenvolvimento

O worker sob launchd (`com.escolaamericana.rm-toddle.worker-students`) martela um
Redis local fora do ar desde 16/09, ~1 GB/dia. Sem rotação de log, sem teto de
retry de conexão no `ioredis`.

**É o item P1-2 do plano.** O truncamento dos arquivos e o `launchctl` ficam para
lá, ou para uma decisão sua antes disso — não mexi no seu processo.

### 3.2 A senha do RM ainda não foi trocada

O serializador de log que a vazava foi corrigido em 21/09
(`packages/config/src/logger.ts`, com teste). A credencial que esteve exposta
**continua em uso**. Anterior a esta auditoria; registrado por ser o tipo de
pendência que some.

### 3.3 Nenhum `trustProxy` na API

`apps/web/nginx.conf:26` define `X-Forwarded-For`, mas o Fastify não confia em
proxy. `req.ip` é o IP do container do nginx, igual para todos. Hoje não causa
dano; **causaria** no P1-5, transformando o rate-limit num balde único para a
escola inteira. Detalhado na seção 6 do `docs/PLANO.md`.

### 3.4 `apps/worker` não declara nenhuma dependência

`apps/worker/package.json` tem `dependencies` vazio e usa `bullmq`, `ioredis` e
outros por hoisting do workspace raiz. Funciona com npm workspaces e com o
`COPY . .` do Dockerfile. É latente, não quebrado.
