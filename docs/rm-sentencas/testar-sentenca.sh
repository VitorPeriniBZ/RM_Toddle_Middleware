#!/usr/bin/env bash
# =====================================================================
# Testa uma Sentença do RM via wsConsultaSQL, sem passar pelo middleware.
# Lê as credenciais do .env do projeto — nada fica hardcoded aqui.
#
#   ./docs/rm-sentencas/testar-sentenca.sh                      # usa RM_SENTENCA_STUDENTS do .env
#   ./docs/rm-sentencas/testar-sentenca.sh TODDLE.STUDENTS.V2   # testa outra Sentença
#   ./docs/rm-sentencas/testar-sentenca.sh TODDLE.STUDENTS.V2 2027
#
# Mostra: HTTP status, nº de linhas (<Resultado>), as colunas que vieram
# preenchidas e a primeira linha inteira. Coluna ausente = valor NULL
# (o DataSet do .NET omite colunas nulas).
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/../.."

# NÃO usar `. ./.env`: valores sem quotes (ex.: STUDENTS_SYNC_CRON=0 3 * * *)
# fazem o shell tentar executar "3 * * *". O dotenv do Node aceita, o shell não.
# Então lemos apenas as chaves necessárias, tirando quotes se houverem.
env_get() {
  grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"
}

RM_WS_BASEURL=$(env_get RM_WS_BASEURL)
RM_WS_USER=$(env_get RM_WS_USER)
RM_WS_PASS=$(env_get RM_WS_PASS)
RM_CODCOLIGADA=$(env_get RM_CODCOLIGADA)
RM_WS_SISTEMA=$(env_get RM_WS_SISTEMA)

SENTENCA="${1:-$(env_get RM_SENTENCA_STUDENTS)}"
PERLET="${2:-$(env_get RM_CODPERLET)}"
ENDPOINT="${RM_WS_BASEURL}/wsConsultaSQL/IwsConsultaSQL"

echo "sentenca : $SENTENCA"
echo "coligada : $RM_CODCOLIGADA | perlet: $PERLET | sistema: $RM_WS_SISTEMA"
echo "endpoint : $ENDPOINT"
echo

ENVELOPE=$(cat <<XML
<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tot="http://www.totvs.com/">
  <soap:Body>
    <tot:RealizarConsultaSQL>
      <tot:codSentenca>${SENTENCA}</tot:codSentenca>
      <tot:codColigada>${RM_CODCOLIGADA}</tot:codColigada>
      <tot:codSistema>${RM_WS_SISTEMA}</tot:codSistema>
      <tot:parameters>CODCOLIGADA=${RM_CODCOLIGADA};CODPERLET=${PERLET}</tot:parameters>
    </tot:RealizarConsultaSQL>
  </soap:Body>
</soap:Envelope>
XML
)

RESP=$(mktemp)
CODE=$(curl -s -o "$RESP" -w '%{http_code}' \
  -u "${RM_WS_USER}:${RM_WS_PASS}" \
  -H 'Content-Type: text/xml; charset=utf-8' \
  -H 'SOAPAction: http://www.totvs.com/IwsConsultaSQL/RealizarConsultaSQL' \
  --data-binary "$ENVELOPE" \
  "$ENDPOINT")

echo "HTTP $CODE | $(wc -c < "$RESP" | tr -d ' ') bytes"

if [ "$CODE" != "200" ]; then
  echo; echo "--- SOAP Fault ---"
  python3 -c "import re,sys; d=open('$RESP',encoding='utf-8',errors='replace').read(); m=re.search(r'<faultstring[^>]*>(.*?)</faultstring>',d,re.S); print(m.group(1) if m else d[:800])"
  rm -f "$RESP"; exit 1
fi

python3 - "$RESP" <<'PY'
import sys, re, collections
raw = open(sys.argv[1], encoding='utf-8', errors='replace').read()
dec = raw.replace('&lt;','<').replace('&gt;','>').replace('&amp;','&').replace('&#xD;','')
rows = re.findall(r'<Resultado>(.*?)</Resultado>', dec, re.S)
print(f"linhas   : {len(rows)}")
if not rows:
    print("(dataset vazio)"); sys.exit()

cols = collections.Counter()
for r in rows:
    for tag in re.findall(r'<([A-Z0-9_]+)>', r):
        cols[tag] += 1
print(f"\ncolunas preenchidas ({len(cols)}) — 'n/total' mostra em quantas linhas veio valor:")
for c, n in cols.most_common():
    flag = '' if n == len(rows) else '   <-- NULL em algumas linhas'
    print(f"  {c:<20} {n}/{len(rows)}{flag}")

turmas = collections.Counter(re.search(r'<COD_TURMA>(.*?)</COD_TURMA>', r).group(1)
                             for r in rows if '<COD_TURMA>' in r)
print(f"\nturmas distintas ({len(turmas)}):")
for t, n in sorted(turmas.items()):
    print(f"  {t:<20} {n} aluno(s)")

for col in ('STATUS_MATRICULA', 'STATUS_DESCRICAO', 'STATUS_ATIVO', 'NIVEL_ENSINO'):
    vals = collections.Counter(m.group(1) for r in rows
                               if (m := re.search(f'<{col}>(.*?)</{col}>', r)))
    if vals:
        print(f"\ndominio de {col}: " + '  '.join(f'{k!r}={v}' for k, v in sorted(vals.items())))

print("\n--- primeira linha ---")
print(rows[0].strip())
PY

rm -f "$RESP"
