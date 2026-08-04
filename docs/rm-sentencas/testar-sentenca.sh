#!/usr/bin/env bash
# =====================================================================
# Testa uma Sentença do RM via wsConsultaSQL, sem passar pelo middleware.
# Lê as credenciais do .env do projeto — nada fica hardcoded aqui.
#
#   ./docs/rm-sentencas/testar-sentenca.sh                       # RM_SENTENCA_STUDENTS do .env
#   ./docs/rm-sentencas/testar-sentenca.sh TODDLE.STUDENTS.V3
#   ./docs/rm-sentencas/testar-sentenca.sh TODDLE.TURMADISC.V1
#   ./docs/rm-sentencas/testar-sentenca.sh TODDLE.STUDENTS.V3 2027
#
# Serve para qualquer Sentença que receba CODCOLIGADA e CODPERLET. Não tem
# lista de colunas hardcoded: descobre o domínio sozinho, então Sentença nova
# com coluna nova já sai analisada.
#
# Reporta:
#   - HTTP status e nº de linhas
#   - por coluna, em quantas linhas veio valor (coluna ausente no XML = NULL,
#     porque o DataSet do .NET omite coluna nula)
#   - DUPLICIDADE na chave (RA ou ID_TURMADISC): responde se há fan-out de JOIN
#     ou mais de uma matrícula/alocação por chave, sem depender do log do worker
#   - domínio de toda coluna de baixa cardinalidade (CODCURSO, CODFILIAL,
#     STATUS_*, NIVEL_ENSINO, ATIVA...)
#   - cobertura de e-mail: sem e-mail não existe POST /staff no Toddle
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/../.."

# NÃO usar `. ./.env`: valores sem quotes (ex.: STUDENTS_SYNC_CRON=0 3 * * *)
# fazem o shell tentar executar "3 * * *". O dotenv do Node aceita, o shell não.
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

# ATENCAO: o RM devolve SOAP Fault com HTTP **200**. Checar so o status faz
# sentenca inexistente se disfarcar de "dataset vazio". A deteccao e por
# CONTEUDO, nao por status.
if ! python3 - "$RESP" <<'PYFAULT'
import re, sys
d = open(sys.argv[1], encoding='utf-8', errors='replace').read()
dec = d.replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&')

m = re.search(r'<faultstring[^>]*>(.*?)</faultstring>', dec, re.S)
if m:
    print('\n--- SOAP Fault (o RM devolveu com HTTP 200) ---')
    print(m.group(1).strip())
    sys.exit(1)

if '<Resultado>' not in dec:
    for frase in ('nao existe', 'não existe', 'restricao de filtro',
                  'restrição de filtro', 'Exception', 'erro'):
        if frase.lower() in dec.lower():
            print('\n--- resposta sem <Resultado> e com indicio de erro ---')
            print(dec[:1200].strip())
            sys.exit(1)
sys.exit(0)
PYFAULT
then
  echo
  echo "Sentenca nao executou. Se a mensagem fala em 'nao existe ou nao pode ser"
  echo "executada por restricao de filtro', as causas sao duas:"
  echo "  1. a Sentenca nao esta cadastrada com esse codigo no RM, ou"
  echo "  2. esta cadastrada mas o usuario do .env nao tem permissao nela."
  echo "Confira tambem o CODIGO exato: a chave e coligada|sistema|codSentenca."
  rm -f "$RESP"; exit 1
fi

if [ "$CODE" != "200" ]; then
  echo; echo "--- corpo bruto (HTTP $CODE) ---"
  head -c 1200 "$RESP"; echo
  rm -f "$RESP"; exit 1
fi

python3 - "$RESP" <<'PY'
import sys, re, collections

raw = open(sys.argv[1], encoding='utf-8', errors='replace').read()
dec = raw.replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&').replace('&#xD;', '')
rows = re.findall(r'<Resultado>(.*?)</Resultado>', dec, re.S)

print(f"linhas   : {len(rows)}")
if not rows:
    print("(dataset vazio — confira o CODPERLET e os filtros da Sentenca)")
    sys.exit()

def val(row, col):
    m = re.search(f'<{col}>(.*?)</{col}>', row, re.S)
    return m.group(1).strip() if m else None

cols, seen = [], set()
for r in rows:
    for tag in re.findall(r'<([A-Z0-9_]+)>', r):
        if tag not in seen:
            seen.add(tag); cols.append(tag)

print(f"\ncolunas ({len(cols)}) — 'n/total' = em quantas linhas veio valor:")
for c in cols:
    n = sum(1 for r in rows if val(r, c) not in (None, ''))
    flag = '' if n == len(rows) else '   <-- vazia em algumas linhas'
    print(f"  {c:<22} {n}/{len(rows)}{flag}")

# duplicidade na chave de negocio
for chave in ('RA', 'ID_TURMADISC'):
    if chave in cols:
        vals = [v for r in rows if (v := val(r, chave))]
        cnt = collections.Counter(vals)
        dups = {k: v for k, v in cnt.items() if v > 1}
        print(f"\nchave {chave}: {len(vals)} linhas, {len(cnt)} distintos", end='')
        if dups:
            print(f"   <-- {len(dups)} REPETIDO(S)")
            for k, v in sorted(dups.items(), key=lambda x: -x[1])[:10]:
                print(f"    {k}: {v} linhas")
            if len(dups) > 10:
                print(f"    ... e mais {len(dups)-10}")
            print("    Causas possiveis: mais de uma matricula/alocacao para a mesma")
            print("    chave (legitimo), ou fan-out de JOIN (SSTATUS tem CODTIPOCURSO,")
            print("    SPROFESSORTURMA e N:N). Olhe as colunas que DIFEREM entre as linhas.")
        else:
            print("   -> 1:1, sem duplicidade")

# dominio automatico das colunas de baixa cardinalidade
print("\ndominios (colunas com <= 25 valores distintos):")
achou = False
for c in cols:
    vals = collections.Counter(val(r, c) or '(vazio)' for r in rows)
    if len(vals) <= 25 and len(vals) < max(2, len(rows) * 0.5):
        achou = True
        print(f"  {c}: " + '  '.join(f'{k!r}={v}' for k, v in sorted(vals.items())))
if not achou:
    print("  (nenhuma)")

# cobertura de e-mail — trava POST /staff e o enriquecimento do aluno
mails = [c for c in cols if 'EMAIL' in c]
if mails:
    rx = re.compile(r'^\S+@\S+\.\S+$')
    print("\ncobertura de e-mail:")
    for c in mails:
        ok = sum(1 for r in rows if (v := val(r, c)) and rx.match(v))
        print(f"  {c:<22} {ok}/{len(rows)} validos")
    sem = [r for r in rows if not any((v := val(r, c)) and rx.match(v) for c in mails)]
    print(f"  linhas SEM nenhum e-mail valido: {len(sem)}")
    if sem:
        idcol = next((c for c in ('RA', 'CODPROF', 'ID_TURMADISC') if c in cols), None)
        nomecol = next((c for c in ('NOME_COMPLETO', 'NOME_PROFESSOR') if c in cols), None)
        if idcol:
            print("  quem:")
            for r in sem[:15]:
                print(f"    {val(r, idcol)}  {val(r, nomecol) or '' if nomecol else ''}")
            if len(sem) > 15:
                print(f"    ... e mais {len(sem)-15}")

# turmas, quando a Sentenca traz turma
if 'COD_TURMA' in cols:
    turmas = collections.Counter(val(r, 'COD_TURMA') for r in rows if val(r, 'COD_TURMA'))
    print(f"\nturmas distintas ({len(turmas)}):")
    for t, n in sorted(turmas.items()):
        print(f"  {t:<20} {n} linha(s)")

print("\n--- primeira linha ---")
print(rows[0].strip())
PY

rm -f "$RESP"
