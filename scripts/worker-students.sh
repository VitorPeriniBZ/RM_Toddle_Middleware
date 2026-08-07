#!/bin/bash
#
# Runner do worker de alunos, para o launchd (ver
# ~/Library/LaunchAgents/com.escolaamericana.rm-toddle.worker-students.plist).
#
# Por que um script em vez de chamar `npm run worker:students` direto no plist:
#   1. o launchd não carrega o shell do usuário, então nvm/PATH não existem lá;
#   2. `npm run` interpõe um processo entre o launchd e o node — o SIGTERM do
#      `launchctl stop` iria para o npm e o encerramento gracioso do worker
#      (worker.close() + fechar pools) não rodaria. Com `exec`, o tsx assume o
#      PID e recebe o sinal.
#
set -euo pipefail

REPO="/Users/vitor.biazutti/WebstormProjects/RM_Toddle_Middleware"
NODE_BIN="/Users/vitor.biazutti/.nvm/versions/node/v26.2.0/bin"

cd "$REPO"
export PATH="$NODE_BIN:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

exec "$NODE_BIN/node" node_modules/tsx/dist/cli.mjs \
  apps/worker/src/workers/rm-to-toddle/studentSync.worker.ts
