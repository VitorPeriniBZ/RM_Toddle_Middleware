#!/bin/bash
# =============================================================================
# Abre um túnel SSH até o Postgres do Coolify para conectar a IDE (WebStorm /
# DataGrip) no banco de produção.
#
# Por que um túnel e não conexão direta: o Postgres do Coolify é um recurso
# GERENCIADO e NÃO publica porta no host — `docker inspect` mostra
# {"5432/tcp": null}. Ou seja, não existe `servidor:5432` para apontar a IDE, e
# a alternativa da UI do Coolify ("make publicly available") abriria o banco
# para a internet inteira. O túnel deixa o banco fechado e só esta máquina vê.
#
# Por que o alvo é o IP do container e não o `localhost` do servidor: sem porta
# publicada, o host não escuta em 5432; quem escuta é o container, no IP dele
# dentro da rede `coolify`. Esse IP MUDA quando o container reinicia — por isso
# o script o resolve a cada execução, em vez de deixar um número fixo colado na
# configuração da IDE, que quebraria calado no próximo restart do banco.
#
# Configuração: as mesmas variáveis do pull-backup-coolify.sh
#   COOLIFY_SSH_HOST      apelido do ~/.ssh/config (ex.: coolify-eav)
#   COOLIFY_PG_CONTAINER  nome/id do container do Postgres
#   COOLIFY_PG_USER       padrão: postgres
#   COOLIFY_PG_DB         padrão: postgres
#   PORTA_LOCAL           padrão: 55433. Não é 5432 nem 5433 de propósito — o
#                         5433 é o Postgres LOCAL do docker-compose.yml, e
#                         confundir os dois é escrever em produção achando que
#                         se está no de desenvolvimento. Também não é 55432:
#                         nesta máquina o `portal-eav-db-1` já escuta lá.
#
# Uso:  ./scripts/tunel-db-coolify.sh     (fica em primeiro plano; Ctrl-C fecha)
# =============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "${COOLIFY_SSH_HOST:-}" || -z "${COOLIFY_PG_CONTAINER:-}" ]] && [[ -f "$REPO/.env" ]]; then
  while IFS='=' read -r chave valor; do
    case "$chave" in
      COOLIFY_SSH_HOST|COOLIFY_PG_CONTAINER|COOLIFY_PG_DB|COOLIFY_PG_USER)
        [[ -z "${!chave:-}" ]] && export "$chave=$valor"
        ;;
    esac
  done < <(grep -E '^COOLIFY_(SSH_HOST|PG_CONTAINER|PG_DB|PG_USER)=' "$REPO/.env" || true)
fi

: "${COOLIFY_SSH_HOST:?COOLIFY_SSH_HOST não definida — ambiente ou .env}"
: "${COOLIFY_PG_CONTAINER:?COOLIFY_PG_CONTAINER não definida — rode: ssh \$COOLIFY_SSH_HOST 'docker ps'}"
PG_USER="${COOLIFY_PG_USER:-postgres}"
PG_DB="${COOLIFY_PG_DB:-postgres}"
PORTA_LOCAL="${PORTA_LOCAL:-55433}"

log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }

# Porta local ocupada é, quase sempre, um túnel destes já aberto. Avisar aqui é
# melhor do que deixar o ssh morrer com "Address already in use" lá embaixo.
if lsof -nP -iTCP:"$PORTA_LOCAL" -sTCP:LISTEN >/dev/null 2>&1; then
  log "ERRO: porta $PORTA_LOCAL já está em uso — provavelmente um túnel aberto:"
  lsof -nP -iTCP:"$PORTA_LOCAL" -sTCP:LISTEN
  exit 1
fi

log "resolvendo o IP do container $COOLIFY_PG_CONTAINER em $COOLIFY_SSH_HOST..."
IP_CONTAINER="$(ssh -o ConnectTimeout=10 "$COOLIFY_SSH_HOST" \
  "docker inspect $COOLIFY_PG_CONTAINER --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'" | tr -d '\r')"

[[ -n "$IP_CONTAINER" ]] || { log "ERRO: não achei o IP do container (ele está de pé?)"; exit 1; }

# A senha vai para a área de transferência, não para a tela: terminal vira log, e
# esta é a do superusuário do banco de produção.
SENHA="$(ssh -o ConnectTimeout=10 "$COOLIFY_SSH_HOST" \
  "docker exec $COOLIFY_PG_CONTAINER printenv POSTGRES_PASSWORD" | tr -d '\r\n')"
if command -v pbcopy >/dev/null 2>&1 && [[ -n "$SENHA" ]]; then
  printf '%s' "$SENHA" | pbcopy
  SENHA_AVISO="senha de $PG_USER: copiada para a área de transferência (Cmd-V na IDE)"
else
  SENHA_AVISO="senha: ssh $COOLIFY_SSH_HOST \"docker exec $COOLIFY_PG_CONTAINER printenv POSTGRES_PASSWORD\""
fi
unset SENHA

cat <<FIM

  Fonte de dados na IDE (PostgreSQL, SEM túnel configurado na IDE — ele é este script):
    Host      127.0.0.1
    Porta     $PORTA_LOCAL
    Banco     $PG_DB
    Usuário   $PG_USER
    $SENHA_AVISO

  ISTO É PRODUÇÃO. O banco local de desenvolvimento é o localhost:5433.
  Ctrl-C encerra o túnel.

FIM

log "túnel 127.0.0.1:$PORTA_LOCAL -> $IP_CONTAINER:5432 (via $COOLIFY_SSH_HOST)"
# ExitOnForwardFailure: sem isto o ssh conecta, falha só o encaminhamento e fica
# de pé parecendo que deu certo — a IDE erra com "connection refused" e o log do
# túnel não acusa nada.
exec ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -L "127.0.0.1:$PORTA_LOCAL:$IP_CONTAINER:5432" "$COOLIFY_SSH_HOST"
