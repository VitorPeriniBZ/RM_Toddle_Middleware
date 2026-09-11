#!/usr/bin/env bash
# =====================================================================
# Exporta as Sentenças COMO ESTÃO no RM, para dentro do repositório.
#
#   ./docs/rm-sentencas/exportar-sentencas.sh            # compara e relata
#   ./docs/rm-sentencas/exportar-sentencas.sh --gravar   # sobrescreve .sql + manifesto
#
# PARA QUE SERVE: a Sentença mora no BANCO (GCONSSQL + GCONSSQLPARAMETROS).
# Toda cópia de base por cima do dev apaga as seis — aconteceu em 13–15/08/2026.
# Este script tira o retrato antes da cópia e, depois dela, prova o que sumiu.
#
# COMO LÊ: ReadRecord no DataServer GlbConsSQLData, chave CODCOLIGADA;S;<codigo>.
# É leitura pura — não existe caminho aqui para gravar no RM.
#
# O QUE O .sql NAO GUARDA: o corpo e so metade. TITULO, GUID, CONTROLE,
# SEMSEGCOLUNAS, SEMSEGESTENDIDA, DISPONIVEL* e os TIPOS dos parametros moram no
# banco e somem junto. Por isso o --gravar tambem escreve `sentencas.manifesto.json`,
# que distingue NULL (elemento ausente no XML do DataSet .NET) de string vazia —
# a diferenca importa na hora de recadastrar.
#
# NÃO CONFUNDA com a sonda de erro (chamar com nº errado de parâmetros). Aquela
# devolve o SQL já NORMALIZADO pelo RM, com os parâmetros trocados para @NOME.
# O corpo real, com :NOME, só vem por ReadRecord — e é o que se cola de volta.
# =====================================================================
set -uo pipefail
cd "$(dirname "$0")/../.."

GRAVAR=0
[ "${1:-}" = "--gravar" ] && GRAVAR=1

env_get() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"; }
BASE=$(env_get RM_WS_BASEURL); U=$(env_get RM_WS_USER); P=$(env_get RM_WS_PASS)
COL=$(env_get RM_CODCOLIGADA)
DIR="docs/rm-sentencas"
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

SENTENCAS="TODDLE.STUDENTS TODDLE.TURMADISC TODDLE.RESP TODDLE.FREQ TODDLE.NOTAS TODDLE.PLANOAULA"
MANIFESTO="$DIR/sentencas.manifesto.json"

echo "coligada : $COL | aplicacao: S"
echo "endpoint : ${BASE}/wsDataServer/IwsDataServer"
[ $GRAVAR -eq 1 ] && echo "modo     : GRAVAR (sobrescreve os .sql)" || echo "modo     : comparar (nada e escrito; use --gravar)"
echo

FALTA=0; DIVERGE=0
for S in $SENTENCAS; do
  XML="<?xml version=\"1.0\" encoding=\"utf-8\"?><soap:Envelope xmlns:soap=\"http://schemas.xmlsoap.org/soap/envelope/\" xmlns:tot=\"http://www.totvs.com/\"><soap:Body><tot:ReadRecord><tot:DataServerName>GlbConsSQLData</tot:DataServerName><tot:PrimaryKey>${COL};S;${S}</tot:PrimaryKey><tot:Contexto>CODCOLIGADA=${COL};CODSISTEMA=G</tot:Contexto></tot:ReadRecord></soap:Body></soap:Envelope>"
  curl -s -m 45 -u "$U:$P" -X POST "${BASE}/wsDataServer/IwsDataServer" \
       -H 'Content-Type: text/xml;charset=UTF-8' \
       -H 'SOAPAction: http://www.totvs.com/IwsDataServer/ReadRecord' \
       -d "$XML" > "$OUT/$S.xml"

  RES=$(SENT="$S" OUTDIR="$OUT" DEST="$DIR" GRAVAR=$GRAVAR python3 - <<'PY'
import hashlib, html, json, os, re, pathlib, sys
s   = os.environ["SENT"]; out = pathlib.Path(os.environ["OUTDIR"])
dest= pathlib.Path(os.environ["DEST"]); gravar = os.environ["GRAVAR"] == "1"
t = html.unescape(html.unescape((out / f"{s}.xml").read_text(errors="replace")))
g = lambda k, src=t: (re.search(r"<%s>(.*?)</%s>" % (k, k), src, re.S) or [None, ""])[1]
corpo = g("SENTENCA")
if not corpo.strip():
    print("AUSENTE|||"); sys.exit(0)
# verbatim: o RM guarda as linhas em branco, e elas sao parte do .sql colavel.
# So normaliza CRLF -> LF e garante quebra final. O cabecalho "--RM.Con..." NAO
# vem aqui (ele so existe na mensagem de erro da sonda), mas tiramos por seguranca.
corpo = re.sub(r"^\s*--RM\.Con\.Conector[^\n]*\n", "", corpo.replace("\r\n", "\n").replace("\r", "\n"))
corpo = corpo.rstrip("\n") + "\n"
blocos = re.findall(r"<GConsSqlParams>(.*?)</GConsSqlParams>", t, re.S)
def campo(k, src):
    m = re.search(r"<%s>(.*?)</%s>" % (k, k), src, re.S)
    return m.group(1) if m else None        # None = ausente no XML = NULL no banco
params = [{"NOME": campo("NOME", b), "DESCRICAO": campo("DESCRICAO", b),
           "TIPO": campo("TIPO", b)} for b in blocos]
alvo = dest / f"{s}.sql"
atual = alvo.read_text() if alvo.exists() else ""
igual = atual.split() == corpo.split()
if gravar:
    if not igual:
        alvo.write_text(corpo)
    reg = re.search(r"<GConsSql>(.*?)</GConsSql>", t, re.S)
    reg = reg.group(1) if reg else t
    meta = {c: campo(c, reg) for c in [
        "CODCOLIGADA", "APLICACAO", "CODSENTENCA", "TITULO", "TAMANHO", "DISPONIVEL",
        "IDGRUPO", "NIVEL", "DISPONIVELFILTRO", "DISPONIVELRELATORIO", "DISPONIVELVISAO",
        "DISPONIVELMENU", "NOMEFANTASIA", "IDDBCONNECTION", "PODEALTERAR", "PODEEXCLUIR",
        "SEMSEGCOLUNAS", "SEMSEGESTENDIDA", "GUID", "VERSAO", "CONTROLE", "NOMESISTEMA",
        "DTULTALTERACAO", "USRULTALTERACAO"]}
    meta["PARAMETROS"] = params
    meta["SHA256_SENTENCA"] = hashlib.sha256(corpo.encode()).hexdigest()
    man = dest / "sentencas.manifesto.json"
    todos = json.loads(man.read_text()) if man.exists() else {}
    todos[s] = meta
    man.write_text(json.dumps(todos, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
resumo = ", ".join(f"{p['NOME']}:{p['TIPO'] if p['TIPO'] is not None else 'NULL'}" for p in params)
print(f"{'IGUAL' if igual else 'DIVERGE'}|||{g('TITULO')}|||{resumo}|||{g('DTULTALTERACAO')[:19]} {g('USRULTALTERACAO')}")
PY
)
  ST=${RES%%|||*}; REST=${RES#*|||}
  TIT=${REST%%|||*}; REST=${REST#*|||}
  PAR=${REST%%|||*}; ALT=${REST#*|||}

  case "$ST" in
    AUSENTE) printf '  %-18s NAO EXISTE NO RM\n' "$S"; FALTA=$((FALTA+1)) ;;
    IGUAL)   printf '  %-18s ok        %s  [%s]  alt: %s\n' "$S" "$TIT" "$PAR" "$ALT" ;;
    *)       printf '  %-18s DIVERGE   %s  [%s]  alt: %s\n' "$S" "$TIT" "$PAR" "$ALT"; DIVERGE=$((DIVERGE+1)) ;;
  esac
done

echo
echo "ausentes no RM: $FALTA | divergentes do repo: $DIVERGE"
if [ $DIVERGE -gt 0 ] && [ $GRAVAR -eq 0 ]; then
  echo "Rode com --gravar para trazer o RM para o repo, ou corrija o RM se o repo e que esta certo."
fi
[ $FALTA -gt 0 ] && exit 2
exit 0
