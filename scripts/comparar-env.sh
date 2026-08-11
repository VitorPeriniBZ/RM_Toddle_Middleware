#!/bin/bash
# =============================================================================
# Compara o .env LOCAL com o ambiente REAL do container em produção.
#
# ─── POR QUE ISTO EXISTE ────────────────────────────────────────────────────
#
# Em 10/08/2026 eu adicionei `RM_SENTENCA_TURMADISC` no .env local e esqueci em
# produção. O job `staff.sync` rodou às 03:30, morreu nas 3 tentativas e foi para
# a DLQ. O erro era ruidoso e nomeava a variável — mas ninguém estava olhando às
# 3h da manhã, e o job ficou quebrado por um dia.
#
# Este comparador é a checagem que faltava. Rode depois de mexer em variável, e
# antes de confiar num deploy.
#
# ─── DE ONDE VEM A VERDADE DE PRODUÇÃO ──────────────────────────────────────
#
# `docker exec ... printenv` — o ambiente que o processo REALMENTE vê, não o que
# a UI do Coolify diz. Se o container não foi redeployado depois de você salvar a
# variável, este script mostra a diferença; a UI não.
#
# ─── SEGREDO NÃO É IMPRESSO ─────────────────────────────────────────────────
#
# Valor de chave sensível (PASS/TOKEN/SECRET/URL de banco) é comparado por HASH.
# O script diz "difere" sem revelar o quê.
#
# Uso:  ./scripts/comparar-env.sh
#       COOLIFY_SERVICO=api ./scripts/comparar-env.sh   # outro serviço
# =============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_ENV="$REPO/.env"
SERVICO="${COOLIFY_SERVICO:-worker}"

# Reaproveita a config do pull de backup: mesmo host, mesma chave.
env_get() { grep -E "^$1=" "$LOCAL_ENV" 2>/dev/null | head -1 | cut -d= -f2- || true; }
SSH_HOST="${COOLIFY_SSH_HOST:-$(env_get COOLIFY_SSH_HOST)}"
: "${SSH_HOST:?COOLIFY_SSH_HOST não definida (ambiente ou .env)}"

[[ -f "$LOCAL_ENV" ]] || { echo "sem $LOCAL_ENV"; exit 1; }

echo "comparando .env local  ×  container '$SERVICO' em $SSH_HOST"
echo

# --- produção: printenv do container do serviço ------------------------------
REMOTO=$(ssh -o BatchMode=yes -o ConnectTimeout=20 "$SSH_HOST" \
  "docker exec \$(docker ps --filter 'name=${SERVICO}-' --format '{{.Names}}' | head -1) printenv" 2>/dev/null) \
  || { echo "FALHOU: não consegui ler o env do container '$SERVICO'."; exit 1; }

[[ -n "$REMOTO" ]] || { echo "FALHOU: printenv voltou vazio — container '$SERVICO' existe?"; exit 1; }

# --- só as chaves que a APLICAÇÃO declara --------------------------------------
# Comparar tudo afogaria o relatório: o container tem PATH, HOSTNAME, NODE_VERSION,
# COOLIFY_* e dezenas de outras que não são nossas. A fonte da verdade sobre "o
# que é nosso" é o schema Zod em packages/config/src/env.ts.
CHAVES=$(grep -oE '^  [A-Z][A-Z0-9_]+:' "$REPO/packages/config/src/env.ts" | tr -d ' :' | sort -u)
[[ -n "$CHAVES" ]] || { echo "FALHOU: não extraí chave nenhuma do schema em env.ts"; exit 1; }

sensivel() { [[ "$1" =~ (PASS|TOKEN|SECRET|DATABASE_URL|REDIS_URL) ]]; }
hash_de()  { printf '%s' "$1" | shasum -a 256 | cut -c1-8; }

# Chaves que DEVEM diferir entre local e produção: são infraestrutura e ambiente,
# não configuração de negócio. Sem esta lista o relatório grita 3 vezes por
# design e ninguém confia nele.
diferem_por_design() { [[ "$1" =~ ^(DATABASE_URL|REDIS_URL|NODE_ENV|API_HOST|API_PORT|WEB_ORIGINS)$ ]]; }

# Chaves com `.default()` no schema: ausentes em produção, a aplicação usa o
# default e nada quebra. Extraído do próprio env.ts para não desatualizar.
#
# O regex olha a LINHA inteira em vez de `z\.[^,]*\.default\(`: aquela versão
# perdia `LOG_LEVEL: z.enum([...]).default('info')`, porque os parênteses do
# `enum` cortavam o casamento — e LOG_LEVEL aparecia como alerta falso.
COM_DEFAULT=$(grep -E "^  [A-Z][A-Z0-9_]+: .*\.default\(" "$REPO/packages/config/src/env.ts" \
  | sed -E 's/^  ([A-Z0-9_]+):.*/\1/' | sort -u)
tem_default() { printf '%s\n' "$COM_DEFAULT" | grep -qx "$1"; }

# Chaves DERIVADAS: o `env` as calcula quando ausentes (ver o objeto exportado no
# fim de env.ts). TODDLE_BASE_URL sai de TODDLE_REGION. Ausência em produção é o
# desenho, não falta.
derivada() { [[ "$1" =~ ^(TODDLE_BASE_URL)$ ]]; }

# CRÍTICAS: divergir ou faltar é ALERTA mesmo tendo default, porque o default NÃO
# é seguro. Elas decidem O QUE é escrito e ONDE.
#
# O caso que motivou esta lista: `SOURCE_ID_PREFIX` tem `.default('')`, então a
# heurística "tem default = inofensivo" o classificava como aviso. Mas prefixo
# vazio faz a busca por sourceId no Toddle não achar ninguém e o middleware CRIAR
# 253 ALUNOS DUPLICADOS — irreversível, porque aluno no Toddle só arquiva.
# Ter default não significa que o default serve.
critica() {
  [[ "$1" =~ ^(SOURCE_ID_PREFIX|TENANT_SLUG|TODDLE_ORG_ID|RM_CODCOLIGADA|RM_CODFILIAL|RM_CODPERLET|RM_TURMAS_IGNORADAS|STUDENTS_SYNC_CRON)$ ]]
}

# Três baldes, por CONSEQUÊNCIA:
#   alerta  — local tem, prod não, e não há default: a aplicação pode falhar em
#             runtime. Foi este o caso do RM_SENTENCA_TURMADISC.
#   avisos  — local tem, prod não, mas há default: prod roda com o default.
#   design  — diferença esperada (infra/ambiente).
alerta=(); avisos=(); design=(); diferentes=(); sobrando=(); iguais=0; ausentes_nos_dois=0

for k in $CHAVES; do
  vl=$(grep -E "^$k=" "$LOCAL_ENV" 2>/dev/null | head -1 | cut -d= -f2- || true)
  vp=$(printf '%s\n' "$REMOTO" | grep -E "^$k=" | head -1 | cut -d= -f2- || true)
  tem_l=$(grep -qE "^$k=" "$LOCAL_ENV" 2>/dev/null && echo 1 || echo 0)
  tem_p=$(printf '%s\n' "$REMOTO" | grep -qE "^$k=" && echo 1 || echo 0)

  # Vazio em local conta como ausente: `CHAVE=` não configura nada.
  [[ -z "$vl" ]] && tem_l=0
  [[ -z "$vp" ]] && tem_p=0

  if [[ "$tem_l" == 1 && "$tem_p" == 0 ]]; then
    if derivada "$k"; then design+=("$k (derivada)")
    elif critica "$k"; then alerta+=("$k (CRÍTICA — tem default, mas o default não serve)")
    elif tem_default "$k"; then avisos+=("$k (prod usa o default do schema)")
    else alerta+=("$k")
    fi
  elif [[ "$tem_l" == 0 && "$tem_p" == 1 ]]; then sobrando+=("$k")
  elif [[ "$tem_l" == 0 && "$tem_p" == 0 ]]; then ausentes_nos_dois=$((ausentes_nos_dois + 1))
  elif diferem_por_design "$k"; then
    design+=("$k")
  elif [[ "$vl" != "$vp" ]]; then
    if sensivel "$k"; then
      diferentes+=("$k: sensível — não imprimo o valor. sha256[0:8] local=$(hash_de "$vl") prod=$(hash_de "$vp")")
    else
      diferentes+=("$k: local=\"$vl\"  prod=\"$vp\"")
    fi
  else iguais=$((iguais + 1))
  fi
done

# --- relatório ---------------------------------------------------------------
problema=0

if ((${#alerta[@]})); then
  problema=1
  echo "!! FALTA EM PRODUÇÃO, SEM DEFAULT (${#alerta[@]}) — a aplicação pode falhar em runtime."
  echo "   Foi exatamente esta a classe do bug de 10/08 (RM_SENTENCA_TURMADISC)."
  printf '     %s\n' "${alerta[@]}"
  echo
fi

if ((${#diferentes[@]})); then
  problema=1
  echo "!! VALOR DIFERENTE em chave de negócio (${#diferentes[@]}):"
  printf '     %s\n' "${diferentes[@]}"
  echo
fi

if ((${#avisos[@]})); then
  echo "aviso: só em local, mas o schema tem default (${#avisos[@]}) — prod roda com o default:"
  printf '     %s\n' "${avisos[@]}"
  echo
fi

if ((${#sobrando[@]})); then
  echo "só em produção (${#sobrando[@]}) — normal para o que vem do compose:"
  printf '     %s\n' "${sobrando[@]}"
  echo
fi

echo "iguais: $iguais   |   diferem por design: ${#design[@]} (${design[*]:-nenhuma})   |   ausentes nos dois: $ausentes_nos_dois"

if ((problema)); then
  echo
  echo "=> Há divergência. Corrija no Coolify e REDEPLOYE — salvar a variável não"
  echo "   troca o env de um container que já está rodando."
  exit 1
fi

echo "=> Sem divergência nas chaves que a aplicação declara."
