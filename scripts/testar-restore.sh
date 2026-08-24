#!/usr/bin/env bash
# =====================================================================
# Prova que o backup RESTAURA — não que ele existe.
#
#   ./scripts/testar-restore.sh                    # usa o dump mais recente
#   ./scripts/testar-restore.sh backups/coolify/coolify-20260821-090005.sql.gz
#
# ─── POR QUE ISTO EXISTE ─────────────────────────────────────────────────────
#
# O `pull-backup-coolify.sh` já verifica tamanho, integridade do gzip e presença
# de linhas de `id_mapping`. Tudo isso prova que o ARQUIVO está plausível. Nada
# disso prova que ele volta.
#
# E a tabela que importa mais mudou de natureza esta semana: `rm_write_provenance`
# é a única coisa entre "sei o que escrevi no ERP do cliente" e "não sei". Perdê-la
# não perde histórico — perde o modelo de segurança inteiro, porque na passada
# seguinte cada linha que nós mesmos escrevemos aparece como CONFLITO_HUMANO (ou,
# se alguém tratar ausência de proveniência como autorização, a integração passa a
# sobrescrever lançamento humano em silêncio).
#
# Backup não testado é hipótese. Este script transforma em fato.
#
# ─── COMO ─────────────────────────────────────────────────────────────────────
#
# Restaura num banco DESCARTÁVEL no Postgres local, confere as tabelas que
# sustentam a integração, e derruba o banco. Não toca o banco de trabalho nem o
# de produção.
# =====================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

PG_CONTAINER="rm_toddle_middleware-postgres-1"
BANCO_TESTE="restore_teste_$$"
DUMP="${1:-}"

log() { printf '  %s\n' "$*"; }
falhar() {
  printf '\n  FALHOU: %s\n\n' "$*"
  docker exec "$PG_CONTAINER" psql -U middleware -d postgres \
    -c "DROP DATABASE IF EXISTS $BANCO_TESTE" >/dev/null 2>&1 || true
  exit 1
}

if [[ -z "$DUMP" ]]; then
  DUMP=$(find backups/coolify -name 'coolify-*.sql.gz' -type f -print0 2>/dev/null \
         | xargs -0 ls -t 2>/dev/null | head -1 || true)
fi
[[ -n "$DUMP" && -f "$DUMP" ]] || falhar "nenhum dump encontrado. Rode ./scripts/pull-backup-coolify.sh"

docker exec "$PG_CONTAINER" true 2>/dev/null \
  || falhar "Postgres local não está de pé. Rode: docker compose up -d"

echo
echo "══════════════════════════════════════════════════════════════════════"
echo "  Teste de RESTORE — o backup volta?"
echo "══════════════════════════════════════════════════════════════════════"
log "dump  : $DUMP ($(du -h "$DUMP" | cut -f1))"
log "banco : $BANCO_TESTE (descartável)"
echo

# --- restaura ---------------------------------------------------------------
docker exec "$PG_CONTAINER" psql -U middleware -d postgres \
  -c "CREATE DATABASE $BANCO_TESTE" >/dev/null 2>&1 \
  || falhar "não foi possível criar o banco de teste"

ERRO_RESTORE=$(mktemp)
if ! gzip -dc "$DUMP" | docker exec -i "$PG_CONTAINER" \
      psql -U middleware -d "$BANCO_TESTE" -v ON_ERROR_STOP=1 >/dev/null 2>"$ERRO_RESTORE"; then
  log "stderr do psql:"
  tail -5 "$ERRO_RESTORE" | sed 's/^/      /'
  rm -f "$ERRO_RESTORE"
  falhar "o dump NÃO restaurou"
fi
rm -f "$ERRO_RESTORE"
log "restore: OK"
echo

# --- confere o que sustenta a integração ------------------------------------
#
# A ordem não é alfabética: é por consequência de perder a tabela.
# Formato: tabela : migration que a cria : papel
#
# A migration importa. Um dump tirado quando a produção estava na migration 8 NÃO
# PODE conter `rm_write_provenance` (criada na 009) — e tratar isso como falha de
# backup é alarme falso, que foi exatamente o que a primeira versão deste script
# fez. O que se cobra de um dump é fidelidade ao schema QUE ELE CARREGA, não ao
# schema que o meu laptop tem hoje.
TABELAS=(
  "rm_write_provenance:009:o que escrevemos no RM — perder = perder o modelo de segurança"
  "id_mapping:001:o de-para RM<->Toddle — perder = duplicar aluno no Toddle"
  "write_pendency:010:o que recusamos e alguém precisa decidir"
  "job_run:011:histórico de execução"
  "operation:006:trilha de aprovação humana"
  "approval:006:quem aprovou o quê"
  "tenant:006:sem ele nada resolve"
  "schema_migrations:000:qual versão do schema este dump carrega"
)

# Até que migration este dump foi tirado? É a régua contra a qual se julga.
ULTIMA_MIGRATION=$(docker exec "$PG_CONTAINER" psql -U middleware -d "$BANCO_TESTE" -t -A \
  -c "select coalesce(max(substring(filename from '^[0-9]+')), '000') from schema_migrations" \
  2>/dev/null | tr -d ' ')
log "schema do dump: migration $ULTIMA_MIGRATION"
echo

falhas=0
ausentes_esperadas=0
printf '  %-24s %8s  %s\n' "TABELA" "LINHAS" "PAPEL"
for entrada in "${TABELAS[@]}"; do
  tab="${entrada%%:*}"
  resto="${entrada#*:}"
  mig="${resto%%:*}"
  papel="${resto#*:}"

  existe=$(docker exec "$PG_CONTAINER" psql -U middleware -d "$BANCO_TESTE" -t -A \
           -c "select to_regclass('public.$tab') is not null" 2>/dev/null | tr -d ' ')

  if [[ "$existe" != "t" ]]; then
    if [[ "$mig" > "$ULTIMA_MIGRATION" ]]; then
      # Esperado: a migration que cria esta tabela não havia rodado quando o
      # dump foi tirado. O backup está correto; a produção é que está atrás.
      printf '  %-24s %8s  %s\n' "$tab" "n/a" "criada na migration $mig — depois deste dump"
      ausentes_esperadas=$((ausentes_esperadas + 1))
    else
      printf '  %-24s %8s  %s\n' "$tab" "AUSENTE" "$papel"
      falhas=$((falhas + 1))
    fi
    continue
  fi
  n=$(docker exec "$PG_CONTAINER" psql -U middleware -d "$BANCO_TESTE" -t -A \
      -c "select count(*) from $tab" 2>/dev/null | tr -d ' ')
  printf '  %-24s %8s  %s\n' "$tab" "$n" "$papel"
done

# --- a prova que interessa: o de-para volta utilizável ----------------------
echo
log "de-para por tipo, como ele volta:"
docker exec "$PG_CONTAINER" psql -U middleware -d "$BANCO_TESTE" -t -A -F'|' \
  -c "select entity_type, count(*), max(updated_at)::date from id_mapping group by 1 order by 1" \
  2>/dev/null | sed 's/^/      /'

docker exec "$PG_CONTAINER" psql -U middleware -d postgres \
  -c "DROP DATABASE $BANCO_TESTE" >/dev/null 2>&1

echo
if [[ "$falhas" -gt 0 ]]; then
  falhar "$falhas tabela(s) que DEVERIAM estar no dump estão ausentes"
fi
echo "  OK: o dump restaura, e todas as tabelas do schema que ele carrega voltaram."
if [[ "$ausentes_esperadas" -gt 0 ]]; then
  echo
  echo "  ATENÇÃO: $ausentes_esperadas tabela(s) do schema ATUAL não existem neste dump,"
  echo "  porque a produção ainda está na migration $ULTIMA_MIGRATION. Não é defeito do"
  echo "  backup — é sinal de que produção precisa de redeploy para rodar as migrations"
  echo "  novas. Até lá, não há backup do que essas tabelas guardariam."
fi
echo
echo "  Ressalva honesta: isto prova que o BACKUP volta. Não prova que o RM"
echo "  aceita ser revertido — a lista do que a integração escreveu está em"
echo "  rm_write_provenance (npm run runs mostra o total), e desfazer no RM é"
echo "  operação à parte, com PRESENCA='P' para frequência."
echo
