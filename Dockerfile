# =============================================================================
# Imagem do middleware RM <-> Toddle, para deploy no Coolify.
#
# Node 24-alpine (LTS). O desenvolvimento local usa 26.2.0, que em agosto/2026
# ainda é "Current" e não LTS — para o sistema que escreve no registro acadêmico
# da escola eu prefiro LTS. Se quiser paridade exata com a sua máquina, troque
# as duas linhas `FROM` para 26-alpine.
#
# NÃO compilamos com tsc, de propósito. Os `paths` do tsconfig apontam para
# `packages/*/src/index.ts` e cada workspace declara `main: src/index.ts`, então
# compilar exigiria reescrever a resolução de módulos nos 9 workspaces. Rodamos
# `tsx` em runtime e, em troca, o typecheck roda no BUILD: erro de tipo derruba
# o deploy, que é a proteção que a compilação daria.
#
# Dependências nativas: nenhuma. `pg`, `ioredis` e `tedious` (usado pelo mssql)
# são JS puro, então alpine serve sem toolchain de build.
# =============================================================================

# ---- build: instala, verifica tipos e compila o front ----
FROM node:24-alpine AS build
WORKDIR /app

# Copia tudo de uma vez (o .dockerignore tira node_modules, .env, .git e logs).
# Menos aproveitamento de cache do que copiar só os manifests primeiro, mas
# correto com 9 workspaces — e deploy aqui é evento raro, não loop de dev.
COPY . .

# `--include=dev` é OBRIGATÓRIO aqui, não estilo.
#
# O Coolify injeta as variáveis do projeto como build args e declara os ARG no
# Dockerfile automaticamente ("Added 69 ARG declarations"), então NODE_ENV=production
# chega ao ambiente de build sem eu poder impedir. E `npm ci` com
# NODE_ENV=production OMITE as devDependencies — onde vivem typescript, tsx e
# vite. O resultado foi o deploy de 07/08/2026 13:55 morrendo em
# `npm run typecheck` com exit 127 (comando não encontrado), porque o tsc não
# tinha sido instalado.
#
# A flag torna o build imune ao NODE_ENV de quem chama. E as devDependencies não
# são opcionais nesta imagem: o tsx é o RUNTIME, não ferramenta de build.
RUN npm ci --include=dev

# Erro de tipo tem de derrubar o deploy, não aparecer no log às 3h da manhã.
RUN npm run typecheck

# O front é Vite: gera estático em apps/web/dist.
RUN npm run build --workspace @rm-toddle/web

# ---- runtime: worker, api e os scripts operacionais ----
# devDependencies FICAM na imagem porque o tsx é o runtime, não ferramenta de
# build. Isso também mantém `npm run dlq`, `enqueue:students` e `reconciliar:
# turmas` disponíveis para rodar dentro do container quando você precisar.
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app /app

# O processo não escreve em disco; roda como usuário sem privilégio.
USER node

# Sem CMD: cada serviço do compose define o seu (worker, api ou init).

# ---- web: estático servido por nginx ----
FROM nginx:alpine AS web
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
