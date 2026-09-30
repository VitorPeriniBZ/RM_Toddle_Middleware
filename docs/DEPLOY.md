# Deploy — procedimento manual

Candidato: `main` em **30/09/2026** (bloco P0 + P1-0/A/B/C). Este documento existe porque o deploy
deste projeto é manual: não há webhook, e **merge em `main` não sobe nada**.

Enquanto este checklist não for executado, o código novo não está rodando:
o canal de alerta continua cego, o canário não vigia, e o relógio da sombra do
P0-6 não começou a contar.

---

## 0. ANTES DE SUBIR — o webhook vem primeiro

**Esta é a ordem, e ela importa.** O P0-2 tornou visível que o sistema está
cego; subir o código novo sem canal apenas põe um sistema que sabe gritar num
lugar onde ninguém escuta. Pior: o boot passa a emitir `error` sobre a própria
cegueira, e quem vê isso pela primeira vez vai achar que o deploy quebrou.

Configure **`ALERTA_WEBHOOK_URL`** no ambiente do Coolify antes do deploy.

O mais rápido, sem cadastro:

```
ALERTA_WEBHOOK_URL=https://ntfy.sh/<um-topico-aleatorio-e-dificil-de-adivinhar>
```

O tópico do ntfy é público para quem souber o nome — escolha algo que ninguém
adivinhe, ou use Slack/Discord, que exigem cadastro e são privados por padrão.
O corpo enviado é `{ text, content }`, que os três aceitam sem adaptação.

Os quatro `HEARTBEAT_URL_*` podem ficar para depois: eles cobrem o processo
MORTO, e o webhook sozinho já cobre os dois modos de falha com o processo vivo
(DLQ e vigia), que são os mais frequentes aqui.

---

## 1. O que precisa subir

**API e worker são processos separados, e os dois precisam do código novo.**

| serviço | o que o P0 mudou lá | se não subir |
|---|---|---|
| **worker** | canário, vigia com lembrete do canal, sinal de cruzamento, sombra do P0-6, disjuntor de credencial | nada do P0-4/5/6 existe; **o relógio da sombra não começa** |
| **api** | `/health/ready`, `cegoParaAlertas`, detalhe dos avisos em `/config`, conferência no boot | o readiness não existe; o monitor externo não tem para onde apontar |
| web | nada | — |

> **O cron de frequência das 23h roda no WORKER.** É ele que produz as
> observações da sombra do P0-6. Deployar só a API não inicia o relógio.

---

## 2. Variáveis de ambiente

Todas têm default e **nenhuma é obrigatória para subir**.

### 2.1 Novas

Conferido no diff `827c2ac..main` de `packages/config/src/env.ts`. As duas do
canário vieram no P0-4; a flag de frequência no P0-6 e a de notas no P1-A,
quando a medição das cadências mostrou que um interruptor só faria um dos
relógios mentir.

| variável | default | efeito do default |
|---|---|---|
| `CANARIO_RELEITURA_MS` | `3600000` (1h) | corpo das Sentenças conferido de hora em hora — 144 leituras/dia |
| `CANARIO_EXECUCAO_MS` | `86400000` (24h) | execução completa 1×/dia (~70s medidos) |
| `FALHA_ALTA_COLUNA_AUSENTE_FREQUENCIA` | `false` | **modo SOMBRA. NÃO ativar neste deploy** — ver §4 |
| `FALHA_ALTA_COLUNA_AUSENTE_NOTAS` | `false` | idem, para notas. **Relógio SEPARADO** — ver §4 |

### 2.2 Já existiam, e o P0 fez passarem a importar

Estas estavam declaradas em `env.ts` desde antes e vazias em todo lugar. O que
mudou é que a ausência delas deixou de ser silenciosa: o boot grita, o
`/health` publica `cegoParaAlertas`, e o alerta sem canal vai para o log em
`error` com o conteúdo inteiro em vez de evaporar.

| variável | default | efeito do default |
|---|---|---|
| `ALERTA_WEBHOOK_URL` | vazia | **sistema cego.** Ver §0 — é a única que vale configurar antes de subir |
| `HEARTBEAT_URL_ALUNOS` | vazia | ninguém reclama se o fluxo de alunos parar |
| `HEARTBEAT_URL_PROFESSORES` | vazia | idem, professores |
| `HEARTBEAT_URL_NOTAS` | vazia | idem, notas (janela do vigia: **4h**) |
| `HEARTBEAT_URL_FREQUENCIA` | vazia | idem, frequência |

### As duas `FALHA_ALTA_COLUNA_AUSENTE_*` ficam em `false`

`false` não é "desligado por preguiça": é o estado de sombra, e ele **já
protege**. Com coluna ausente detectada, o run alerta e **não escreve** — a
sombra deixou de escrever depois da revisão do conselho, porque sobrescrever
lançamento de professor é irreversível e não escrever é atraso.

`true` faz o run abortar com exceção. A diferença é entre "não escrevi e
avisei" e "quebrei o job". Só ligar depois de §4.

**São duas flags, e não uma, porque os relógios de observação são de ordens
diferentes**: `FREQ_SYNC_CRON` roda 1×/dia e `NOTA_SYNC_CRON` 34×/dia. Sete
observações levam sete dias na frequência e cinco horas nas notas. Um
interruptor único obrigaria a ligar a frequência cedo demais ou a segurar as
notas por uma semana sem motivo.

### 2.3 O que NÃO tem flag, e por quê

Três guardas entraram **sem** interruptor, e isso é decisão, não esquecimento.
Elas abortam a operação na hora se o componente da chave faltar:

| guarda | onde | o que faz |
|---|---|---|
| `chaveComposta` | índice de provas e de etapas de nota | recusa componente vazio, nulo, só-espaço ou a string `"undefined"` |
| `chaveNaturalNotaAvaliacao` | chave da nota de avaliação | idem |
| `chaveCourse` | de-para de turma (já existia) | idem |

**Por que sem sombra:** sombra existe para reunir evidência de que a regra nova
não quebra nada, e serve a gatilho **recorrente e indeterminado** — a Sentença
SQL mora no RM e some a cada cópia de base, então não dá para saber quando vai
faltar. Estas três leem do **DataServer**, cujo schema é do produto TOTVS: não
há Sentença a ser apagada.

E foi **medido** antes de ligar: 245 linhas de `SProvas`, 3.507 de `SNotas`,
11.890 da `TODDLE.NOTAS` e 698 da `TODDLE.FREQ` — **zero** componentes de chave
ausentes ou vazios em todas. Sombra sobre zero medido é cerimônia.

**O que esperar se disparar:** exceção com o componente NOMEADO, job vermelho,
DLQ, e o alerta pelo canal. Falhar alto com nome é o desenho — não é o defeito.
Investigar a Sentença ou o DataServer apontado, não reverter o deploy.

---

## 3. Pós-deploy, nesta ordem

```bash
# 1. o canal chega em alguém?  (0 = o canal aceitou)
npm run alerta:testar
```

Saída `0` e **a mensagem chegou de fato** no Slack/Discord/ntfy. Aceitação não
é entrega: um webhook apontando para canal arquivado responde 200 e engole.
Saída `1` = falta a URL (§0). Saída `2` = a URL existe e o canal recusou.

```bash
# 2. as duas sondas
curl -s -o /dev/null -w '%{http_code}\n' https://<host>/api/health        # 200 sempre
curl -s -o /dev/null -w '%{http_code}\n' https://<host>/api/health/ready   # 200 ou 503 honesto
```

`/health` **tem** de dar 200 — ele é o healthcheck do Coolify, e um 503 ali
reinicia o container em laço. `/health/ready` dá 503 se Postgres ou Toddle
estiverem fora; 200 se o Toddle estiver só `limitado` (rate limit não é queda).

```bash
# 3. as Sentenças conferem?  (0 = as seis batem com o repositório)
npm run canario
```

Saída `3` significa que o RM recusou a credencial: o ciclo parou na primeira
tentativa de propósito, e o conserto é no **cadastro do usuário no RM**, não no
`.env`. Ver `docs/TODO.md §0`.

```bash
# 4. as regras que pescam a classe do acesso indexado cru
npm run lint
```

Saída vazia. Se acusar, alguém reintroduziu `String(row.X)` ou template literal
com campo cru do RM — os dois padrões que produziram defeito em caminho de
escrita irreversível.

**5. No dia seguinte**, confirmar que o cron de frequência das 23h rodou e
registrou a primeira observação da sombra. No log do worker:

```
Cruzamento da frequência: distribuição de vereditos
```

Essa linha sai em **toda** passada, com ou sem suspeita — é ela que constrói a
linha de base que hoje não existe. Primeira aparição = **dia 1 de 7**.

**O relógio de NOTAS é outro, e corre muito mais rápido.** `NOTA_SYNC_CRON` é
`15,45 6-22 * * *` — 34 passadas por dia. Sete observações completam em ~5
horas, contra sete dias na frequência. Ver a ressalva em §4.

---

## 4. A sombra do P0-6, e quando ligar o estrito

O relógio começa no **primeiro cron de frequência pós-deploy**, não agora.

**Critério de ativação: 7 observações do cron diário sem nenhum alerta de
coluna ausente.** Sete dias cobrem uma cópia de base típica, que é o evento
que o item existe para pegar.

Linhas de base medidas contra o RM real, antes do deploy:

**Frequência (29/09):**

| medida | valor |
|---|---|
| result set da `TODDLE.FREQ` | 698 linhas, 23 colunas |
| colunas da chave ausentes | 0 |
| chaves com segmento vazio (810 + 223 faltas, duas janelas) | 0 |
| `semChave` | 0 |
| drift simulado (removendo `ID_TURMADISC`) | detectado |

**Notas (30/09):**

| medida | valor |
|---|---|
| result set da `TODDLE.NOTAS` | **11.890 linhas**, 23 colunas |
| colunas da chave ausentes | 0 |
| linhas sem `RA` / `ID_TURMADISC` / `CODETAPA` | 0 / 0 / 0 |
| chaves únicas para 11.890 linhas | **11.890 — zero colisões** |
| drift simulado (removendo `CODETAPA`) | detectado |

> O comentário do código estimava "~7 mil linhas" para a `TODDLE.NOTAS`. São
> **11.890**. O número importa para o custo do canário na camada de execução.

**Os dois relógios são independentes.** O de notas começa no primeiro cron de
notas pós-deploy; o de frequência, no primeiro cron de frequência. Não
unificar os critérios sem decidir.

**Ativar é decisão humana**, não automática. E ativar **reabre junto** a decisão
do canário ser alerta-apenas — as duas andam juntas, e o gatilho está
registrado em `docs/PLANO.md`.

### Uma ressalva sobre o relógio de NOTAS

O critério "7 observações" foi desenhado pensando na frequência, onde 7
observações são 7 dias e cobrem uma cópia de base típica.

Em notas, 7 observações completam em **cinco horas** — e cinco horas **não
cobrem uma cópia de base por construção**. Contar passadas e contar dias
deixam de ser a mesma coisa aqui.

Quando o critério de notas completar, a decisão é: aceitar a contagem (7
passadas, evidência concentrada) ou exigir espalhamento de calendário (N dias,
evidência que atravessa uma cópia de base). **Decidir no momento, com os dados
na mão** — não antecipar.

---

## 5. O launchd local não faz parte deste deploy

O worker sob launchd nesta máquina (`com.escolaamericana.rm-toddle.worker-students`)
martela um Redis local fora do ar desde 16/09 e produz ~1 GB/dia de log.

**Medido em 30/09: 7,2 GB** — eram 6,3 GB em 29/09, o que confirma a taxa. É
independente do deploy e não bloqueia nada aqui, mas é a limpeza mais barata
da lista.

```bash
launchctl bootout gui/$(id -u)/com.escolaamericana.rm-toddle.worker-students
# e truncar: logs/worker-students.log (4,6 GB) e logs/worker-students.error.log (1,7 GB)
```

O comportamento do **código** nesse modo de falha é o item P1-B, ainda não feito.

---

## 6. Rollback

`main` tem sete commits de merge nomeados por item. Reverter um item é
`git revert -m 1 <merge>`; reverter o bloco é voltar a `827c2ac`.

Nenhuma migration foi adicionada pelo P0 — o schema não mudou, então o rollback
é só de código.
