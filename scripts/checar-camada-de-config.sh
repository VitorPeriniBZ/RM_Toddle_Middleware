#!/usr/bin/env bash
# =====================================================================
# Garante que a camada de configuração não seja furada.
#
#   ./scripts/checar-camada-de-config.sh
#
# ─── POR QUE ISTO É MECÂNICO E NÃO UMA CONVENÇÃO ─────────────────────────────
#
# O objetivo do produto é white label: uma escola por configuração, não por
# deploy. Isso só se sustenta se TODA config de escola passar por um lugar. E
# convenção documentada vaza em duas semanas — sempre vaza, porque escrever
# `env.RM_CODFILIAL` é mais rápido do que descobrir onde fica a camada.
#
# Então a regra é verificada, não pedida. Duas regras:
#
#   1. `process.env` só existe em packages/config/src/env.ts.
#   2. Config de ESCOLA (credencial do RM, coligada, campus, período letivo,
#      Sentenças, token e organização do Toddle, prefixo de sourceId, slug do
#      tenant) não é lida de `env.` fora da camada de config.
#
# O que NÃO é config de escola e pode continuar vindo de `env.` em qualquer
# lugar: DATABASE_URL, REDIS_URL, LOG_LEVEL, NODE_ENV, as variáveis da API e do
# Google, SYNC_BATCH_SIZE, os crons, SYNC_DESVIO_MAX_PCT e as URLs de heartbeat.
# Essas são decisões da INSTÂNCIA, e a arquitetura escolhida é deploy por tenant.
# =====================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

falhas=0

# --- regra 1 ----------------------------------------------------------------
fora=$(grep -rn 'process\.env' --include='*.ts' packages apps 2>/dev/null \
       | grep -v 'packages/config/src/env.ts' \
       | grep -v node_modules || true)
if [[ -n "$fora" ]]; then
  echo "FALHOU: process.env fora de packages/config/src/env.ts"
  echo "$fora" | sed 's/^/    /'
  echo "    -> leia do objeto 'env' (infra) ou de 'tenantConfig' (escola)."
  falhas=$((falhas + 1))
fi

# --- regra 2 ----------------------------------------------------------------
# Chaves que descrevem UMA ESCOLA. Se aparecerem como `env.X` fora da camada,
# o código não é white label — está amarrado ao ambiente do deploy.
CHAVES_DE_ESCOLA='RM_WS_BASEURL|RM_WS_USER|RM_WS_PASS|RM_WS_SISTEMA|RM_CODCOLIGADA|RM_CODFILIAL|RM_CODPERLET|RM_ACTIVE_TERM_STATUSES|RM_TURMAS_IGNORADAS|RM_SENTENCA_[A-Z]+|TODDLE_BASE_URL|TODDLE_TOKEN|TODDLE_ORG_ID|TODDLE_PAGE_SIZE|TODDLE_DEFAULT_YEAR_GROUP_ID|SOURCE_ID_PREFIX|TENANT_SLUG'

vazou=$(grep -rnE "\benv\.($CHAVES_DE_ESCOLA)\b" --include='*.ts' packages apps 2>/dev/null \
        | grep -v '^packages/config/src/' \
        | grep -v node_modules || true)
if [[ -n "$vazou" ]]; then
  echo "FALHOU: config de ESCOLA lida do ambiente fora da camada de config"
  echo "$vazou" | sed 's/^/    /'
  echo "    -> use 'tenantConfig' (ou receba 'cfg: TenantConfig' por parâmetro)."
  echo "       Ver packages/config/src/tenantConfig.ts."
  falhas=$((falhas + 1))
fi

if [[ "$falhas" -gt 0 ]]; then
  echo
  echo "$falhas regra(s) violada(s). Cada leitura de env fora da camada é um ponto"
  echo "a refatorar quando a config sair do ambiente para a tabela integration_connection."
  exit 1
fi

echo "OK: process.env confinado ao env.ts, e nenhuma config de escola lida do ambiente fora da camada."
