#!/bin/bash
# =============================================================================
# Puxa um dump do Postgres do Coolify para ESTA máquina, por SSH.
#
# Existe porque o backup agendado do Coolify grava no disco do PRÓPRIO servidor:
# protege contra DELETE errado e migration ruim, mas não contra perder a máquina.
# Este script tira a cópia de lá sem depender de credencial de S3 de terceiro.
#
# O dump é STREAMED pelo SSH, não gerado em arquivo no servidor e copiado depois.
# Dois motivos: o `rm_code` dos 219 PARENT são e-mails de responsáveis, e um
# arquivo temporário no servidor é dado pessoal esquecido em disco alheio; e sem
# etapa intermediária não há o que limpar se o script morrer no meio.
#
# Configuração — em variável de ambiente ou no .env (que é gitignored):
#   COOLIFY_SSH_HOST      usuario@servidor  (obrigatória)
#   COOLIFY_PG_CONTAINER  nome do container do Postgres (obrigatória)
#   COOLIFY_PG_DB         banco (padrão: postgres)
#   COOLIFY_PG_USER       usuário do postgres (padrão: postgres)
#
# Uso:  ./scripts/pull-backup-coolify.sh
# =============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESTINO="$REPO/backups/coolify"
RETER="${BACKUP_RETER:-14}"  # quantos dumps manter

# Piso de bytes DO ARQUIVO JÁ COMPRIMIDO. Serve só para pegar dump vazio ou
# truncado — NÃO para julgar se há dado "suficiente".
#
# Calibrado em 10/08/2026 contra o servidor real, depois de um falso positivo
# instrutivo: eu tinha posto 20000 olhando o dump LOCAL (1884 linhas, 108KB
# comprimido) e o de produção veio com 18,5KB, porque lá só existem os 253
# STUDENT que o sync criou. O piso passou a valer mais que o conteúdo, e um
# backup bom foi recusado. Cinco testes sintéticos não pegaram isso; o dado real
# pegou na primeira.
#
# Referências medidas (comprimido): schema puro ~2,6KB · produção hoje ~18,5KB ·
# local com 1884 linhas ~108KB. 5000 fica acima do schema puro e abaixo de
# qualquer dump com dado de verdade.
MINIMO_BYTES="${BACKUP_MINIMO_BYTES:-5000}"

# Queda brusca de linhas em relação ao último dump bom não derruba o backup (o
# banco pode legitimamente encolher), mas grita no log — é o sinal de que alguém
# apagou dado.
ALERTA_QUEDA_PCT="${BACKUP_ALERTA_QUEDA_PCT:-50}"

# --- configuração: ambiente primeiro, .env como fallback -----------------------
if [[ -z "${COOLIFY_SSH_HOST:-}" || -z "${COOLIFY_PG_CONTAINER:-}" ]] && [[ -f "$REPO/.env" ]]; then
  # Só as chaves deste script, para não importar o .env inteiro para o shell.
  while IFS='=' read -r chave valor; do
    case "$chave" in
      COOLIFY_SSH_HOST|COOLIFY_PG_CONTAINER|COOLIFY_PG_DB|COOLIFY_PG_USER)
        [[ -z "${!chave:-}" ]] && export "$chave=$valor"
        ;;
    esac
  done < <(grep -E '^COOLIFY_(SSH_HOST|PG_CONTAINER|PG_DB|PG_USER)=' "$REPO/.env" || true)
fi

: "${COOLIFY_SSH_HOST:?COOLIFY_SSH_HOST não definida (ex.: deploy@servidor) — ambiente ou .env}"
: "${COOLIFY_PG_CONTAINER:?COOLIFY_PG_CONTAINER não definida — rode: ssh HOST 'docker ps --format {{.Names}}' | grep -i postgres}"
PG_DB="${COOLIFY_PG_DB:-postgres}"
PG_USER="${COOLIFY_PG_USER:-postgres}"

mkdir -p "$DESTINO"
STAMP="$(date +%Y%m%d-%H%M%S)"
ALVO="$DESTINO/coolify-$STAMP.sql.gz"
PARCIAL="$ALVO.parcial"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
falhar() { log "FALHOU: $*"; rm -f "$PARCIAL"; exit 1; }

log "puxando dump de $COOLIFY_SSH_HOST (container $COOLIFY_PG_CONTAINER, banco $PG_DB)"

# `set -o pipefail` já está ativo: se o pg_dump ou o ssh falharem, o pipe falha —
# sem isto um dump vazio passaria por sucesso, que é o pior modo de falha
# possível num backup.
if ! ssh -o BatchMode=yes -o ConnectTimeout=20 "$COOLIFY_SSH_HOST" \
      "docker exec -u postgres '$COOLIFY_PG_CONTAINER' pg_dump -d '$PG_DB' -U '$PG_USER' --no-owner --no-privileges" \
      2>/dev/null | gzip -9 > "$PARCIAL"; then
  falhar "ssh/pg_dump retornou erro (chave SSH? nome do container? BatchMode exige auth sem senha)"
fi

# --- verificações: backup que não é verificado não é backup -------------------
BYTES=$(wc -c < "$PARCIAL" | tr -d ' ')
[[ "$BYTES" -ge "$MINIMO_BYTES" ]] || falhar "dump tem só ${BYTES}B (mínimo $MINIMO_BYTES) — provavelmente vazio"

gzip -t "$PARCIAL" 2>/dev/null || falhar "gzip corrompido"

# A tabela que importa tem de estar lá, com linhas. Tamanho sozinho não prova
# nada: um dump só de schema também passaria do mínimo.
LINHAS=$(gzip -dc "$PARCIAL" | awk '/^COPY public\.id_mapping/{f=1;next} f&&/^\\\.$/{exit} f{c++} END{print c+0}')
[[ "$LINHAS" -gt 0 ]] || falhar "nenhuma linha de id_mapping no dump — schema sem dado?"

# Comparação com o último dump BOM: detecta perda de dado, que nenhum piso
# absoluto pega. Não falha de propósito — o banco pode encolher por motivo
# legítimo, e recusar o backup nesse caso deixaria você SEM cópia justamente no
# dia em que algo estranho aconteceu.
ANTERIOR=$(find "$DESTINO" -name 'coolify-*.sql.gz' -type f -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -1 || true)
if [[ -n "$ANTERIOR" ]]; then
  LINHAS_ANT=$(gzip -dc "$ANTERIOR" | awk '/^COPY public\.id_mapping/{f=1;next} f&&/^\\\.$/{exit} f{c++} END{print c+0}')
  if [[ "$LINHAS_ANT" -gt 0 ]] && [[ $((LINHAS * 100 / LINHAS_ANT)) -lt "$ALERTA_QUEDA_PCT" ]]; then
    log "ATENCAO: id_mapping caiu de $LINHAS_ANT para $LINHAS linhas ($(basename "$ANTERIOR")) — alguem apagou dado?"
  fi
fi

mv "$PARCIAL" "$ALVO"
chmod 600 "$ALVO"   # contém e-mails de responsáveis
log "OK: $ALVO ($(du -h "$ALVO" | cut -f1), $LINHAS linhas de id_mapping)"

# --- rotação ------------------------------------------------------------------
TOTAL=$(find "$DESTINO" -name 'coolify-*.sql.gz' -type f | wc -l | tr -d ' ')
if [[ "$TOTAL" -gt "$RETER" ]]; then
  # `ls -t` ordena por mtime; descarta os mais antigos além do limite.
  find "$DESTINO" -name 'coolify-*.sql.gz' -type f -print0 \
    | xargs -0 ls -t \
    | tail -n +$((RETER + 1)) \
    | while read -r velho; do log "rotacao: removendo $(basename "$velho")"; rm -f "$velho"; done
fi

log "dumps retidos: $(find "$DESTINO" -name 'coolify-*.sql.gz' -type f | wc -l | tr -d ' ')/$RETER"
