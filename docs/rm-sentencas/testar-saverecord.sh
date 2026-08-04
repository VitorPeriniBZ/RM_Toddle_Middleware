#!/usr/bin/env bash
# =====================================================================
# Sonda a operação SaveRecord do wsDataServer do RM — o canal de ESCRITA.
#
#   ./docs/rm-sentencas/testar-saverecord.sh                          # explica e sai
#   ./docs/rm-sentencas/testar-saverecord.sh --executar               # envia a sonda
#   ./docs/rm-sentencas/testar-saverecord.sh --executar EduNotasData  # outro DataServer
#
# PARA QUE SERVE: descobrir se o SaveRecord existe e executa neste ambiente,
# SEM gravar nada. Responde uma pergunta só: "o canal escreve?".
#
# POR QUE ISSO IMPORTA: até 2026-08-04 a conclusão do projeto era que a volta
# Toddle -> RM era impossível sem publicar o REST. Errado. O wsDataServer está
# exposto na MESMA porta 1951 do wsConsultaSQL e responde: um ReadRecord em
# EduAlunoData devolveu o registro completo do aluno (117 KB). O que falta
# confirmar é a escrita, e é isso que este script faz.
#
# ---------------------------------------------------------------------
# SEGURANÇA — leia antes de rodar
#
# 1. O RM aqui é PRODUÇÃO da escola: sistema de registro acadêmico legal
#    (histórico, MEC, Educacenso). Não há sandbox, não há "desfazer".
#
# 2. Por isso o payload é FIXO NO CÓDIGO e VAZIO: <SFREQUENCIA></SFREQUENCIA>.
#    O script NÃO aceita dados por parâmetro — não existe caminho para ele
#    gravar informação real, nem por engano nem de propósito. Se você precisa
#    gravar de verdade, escreva outro script, com revisão e aprovação.
#
# 3. Um dataset vazio não tem chave nem campo obrigatório, então o RM tem de
#    recusar. É justamente a MENSAGEM da recusa que informa:
#      - "Classe não encontrada"            -> o DataServer não existe
#      - erro de validação/campo/chave      -> SaveRecord EXISTE e executou
#      - "não suportado"/"not supported"    -> o canal não escreve
#      - sucesso                            -> INESPERADO: pare e investigue
#
# 4. Por padrão não envia nada: mostra o que faria e sai. Exige --executar.
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
RM_CODFILIAL=$(env_get RM_CODFILIAL)

EXECUTAR=0
DATASERVER='EduFrequenciaDiariaData'
for a in "$@"; do
  case "$a" in
    --executar) EXECUTAR=1 ;;
    -*) echo "opção desconhecida: $a" >&2; exit 2 ;;
    *) DATASERVER="$a" ;;
  esac
done

ENDPOINT="${RM_WS_BASEURL}/wsDataServer/IwsDataServer"
# CODTIPOCURSO=1 ("Ensino Básico") é o único nível nesta base — medido no
# export completo do campus 2. Sem contexto completo o RM responde
# "Contexto inválido OU não foram configurados os parâmetros do Educacional".
CONTEXTO="CODCOLIGADA=${RM_CODCOLIGADA};CODFILIAL=${RM_CODFILIAL};CODTIPOCURSO=1;CODSISTEMA=${RM_WS_SISTEMA}"

# Payload FIXO e vazio. Não parametrizável, de propósito (ver SEGURANÇA item 2).
PAYLOAD_VAZIO='&lt;SFREQUENCIA&gt;&lt;/SFREQUENCIA&gt;'

echo "DataServer : $DATASERVER"
echo "endpoint   : $ENDPOINT"
echo "contexto   : $CONTEXTO"
echo "payload    : <SFREQUENCIA></SFREQUENCIA>   (vazio — nao persiste nada)"
echo

if [ "$EXECUTAR" -ne 1 ]; then
  cat <<'AVISO'
Nada foi enviado.

Este script faz UMA chamada SaveRecord com dataset vazio, para descobrir se a
operacao de escrita existe neste ambiente. Nao grava dado nenhum: o payload e
fixo no codigo e nao aceita parametro.

Ainda assim, e uma chamada de ESCRITA no ERP de PRODUCAO da escola. Rode com
--executar apenas se estiver de acordo:

  ./docs/rm-sentencas/testar-saverecord.sh --executar
AVISO
  exit 0
fi

ENVELOPE=$(cat <<XML
<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tot="http://www.totvs.com/">
  <soap:Body>
    <tot:SaveRecord>
      <tot:DataServerName>${DATASERVER}</tot:DataServerName>
      <tot:XML>${PAYLOAD_VAZIO}</tot:XML>
      <tot:Contexto>${CONTEXTO}</tot:Contexto>
    </tot:SaveRecord>
  </soap:Body>
</soap:Envelope>
XML
)

RESP=$(mktemp)
CODE=$(curl -s -o "$RESP" -w '%{http_code}' --max-time 90 \
  -u "${RM_WS_USER}:${RM_WS_PASS}" \
  -H 'Content-Type: text/xml; charset=utf-8' \
  -H 'SOAPAction: http://www.totvs.com/IwsDataServer/SaveRecord' \
  --data-binary "$ENVELOPE" \
  "$ENDPOINT")

echo "HTTP $CODE | $(wc -c < "$RESP" | tr -d ' ') bytes"
echo

python3 - "$RESP" <<'PY'
import sys, re, html
bruto = open(sys.argv[1], encoding='utf-8', errors='replace').read()
texto = html.unescape(bruto)

# ATENCAO: o RM sinaliza falha de DUAS formas. SOAP Fault e o caminho obvio, mas
# ele tambem devolve HTTP 200 com a mensagem de erro DENTRO de SaveRecordResult
# (as vezes com stack trace .NET). Foi assim que o wsConsultaSQL nos enganou, e
# a primeira versao deste script repetiu o erro: viu "sem faultstring" e concluiu
# que o RM havia ACEITADO um dataset vazio. Nao havia aceitado.
m = re.search(r'<faultstring[^>]*>(.*?)</faultstring>', texto, re.S)
if not m:
    res = re.search(r'<SaveRecordResult[^>]*>(.*?)</SaveRecordResult>', texto, re.S)
    corpo = ' '.join((res.group(1) if res else texto).split())
    marcas_erro = ('nao foi encontrada', 'não foi encontrada', 'erro', 'exception',
                   '   at ', 'invalid', 'inválid', 'obrigat', 'null')
    if any(x in corpo.lower() for x in marcas_erro):
        print('HTTP 200, mas o corpo carrega ERRO (padrao do RM):')
        print('  ' + corpo[:400])
        print()
        print('>>> SaveRecord EXISTE e EXECUTOU. A recusa e sobre o CONTEUDO do')
        print('    payload, nao sobre a operacao. O canal de escrita esta ABERTO.')
        print('    Nada foi persistido: ele nem encontrou dados para gravar.')
        print()
        print('    Isso prova o CANAL, nao a seguranca de gravar frequencia.')
        print('    Cada dominio precisa de homologacao propria, e escrever no')
        print('    sistema de registro legal da escola e decisao de governanca.')
    else:
        print('SEM FAULT e SEM marca de erro — o RM parece ter ACEITADO:')
        print('  ' + corpo[:300])
        print()
        print('>>> INESPERADO. Pare e investigue ANTES de qualquer escrita real:')
        print('    um dataset sem chave nao deveria ser aceito.')
    sys.exit(0)

msg = ' '.join(m.group(1).split())
print('FAULT do RM:')
print('  ' + msg[:500])
print()

low = msg.lower()
if 'classe não encontrada' in low or 'classe nao encontrada' in low:
    print('>>> O DataServer NAO EXISTE com esse nome. Tente outro.')
elif 'not supported' in low or 'não suportad' in low or 'nao suportad' in low:
    print('>>> A operacao SaveRecord NAO e suportada aqui. O canal nao escreve.')
elif 'contexto' in low:
    print('>>> Chegou na camada de negocio, mas o CONTEXTO esta incompleto.')
    print('    Ajuste CODFILIAL/CODTIPOCURSO no .env e repita.')
else:
    print('>>> SaveRecord EXISTE e EXECUTOU a validacao de dominio do RM.')
    print('    A recusa e sobre o CONTEUDO (chave/campo obrigatorio ausente),')
    print('    nao sobre a operacao. Ou seja: o canal de escrita esta aberto.')
    print()
    print('    Isso prova o CANAL, nao a seguranca de gravar frequencia.')
    print('    Cada dominio precisa de homologacao propria, e escrever no')
    print('    sistema de registro legal da escola e decisao de governanca.')
PY

rm -f "$RESP"
