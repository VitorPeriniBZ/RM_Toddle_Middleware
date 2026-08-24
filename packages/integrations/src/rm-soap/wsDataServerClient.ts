import axios, { AxiosInstance } from 'axios';
import { XMLParser } from 'fast-xml-parser';
import { logger, rmSoapConfigurado, tenantConfig, type TenantConfig } from '@rm-toddle/config';

/**
 * Cliente do TOTVS RM wsDataServer (SOAP 1.1) — SOMENTE LEITURA.
 *
 * Diferente do wsConsultaSQL (que executa Sentenças cadastradas), o wsDataServer
 * expõe os DataServers do produto, que encapsulam a regra de negócio. É o canal
 * da via Toddle -> RM.
 *
 *   endpoint  {RM_WS_BASEURL}/wsDataServer/IwsDataServer
 *   auth      HTTP Basic, o mesmo usuário do wsConsultaSQL
 *   contexto  CODCOLIGADA;CODFILIAL;CODTIPOCURSO;CODSISTEMA — obrigatório
 *
 * ─── `saveRecord` PASSOU A EXISTIR EM 21/08/2026 ────────────────────────────
 *
 * Este cabeçalho dizia: "não está implementado de propósito... quando for a
 * hora, ele entra junto com a máquina de aprovação (operation/approval), não
 * antes."
 *
 * A condição foi cumprida. Existem agora: decisão por registro
 * (`decidirEscrita`, 6 vereditos), proveniência do que escrevemos
 * (`rm_write_provenance`), fila do que foi recusado (`write_pendency`) e teto de
 * volume com gate humano (`avaliarVolume` + `operation`/`approval`).
 *
 * O método NÃO é usado por nenhum job agendado. Só o
 * `npm run lancar:falta -- --executar` o chama, com uma linha, e por decisão
 * explícita de quem digita.
 *
 * ─── DUAS ARMADILHAS MEDIDAS ────────────────────────────────────────────────
 *
 * 1. O RM sinaliza erro de negócio com **HTTP 200** e a mensagem DENTRO do
 *    corpo, frequentemente com stack trace .NET. Este projeto já se enganou
 *    duas vezes com isso. `assertNoRmError` cuida do caso.
 *
 * 2. Os elementos-linha vêm em **case misto** (`SEtapas`, `SHorarioTurma`,
 *    `SPLetivo`, `STurmaDisc`) — não em maiúsculas. Um seletor que assume
 *    maiúsculas encontra zero linhas SEM erro, o que parece "tabela vazia".
 *    Por isso `readView` recebe o nome do elemento e o compara sem case.
 */

const SOAP_NS = 'http://schemas.xmlsoap.org/soap/envelope/';
const TOTVS_NS = 'http://www.totvs.com/';
const SERVICE_PATH = '/wsDataServer/IwsDataServer';

export type DataServerRow = Record<string, string>;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export class RmDataServerError extends Error {
  constructor(
    message: string,
    readonly dataServer: string,
  ) {
    super(message);
    this.name = 'RmDataServerError';
  }
}

class WsDataServerClient {
  private readonly http: AxiosInstance;
  private readonly parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false, // tudo string; conversão é do chamador
    trimValues: true,
    removeNSPrefix: true,
    processEntities: {
      enabled: true,
      maxTotalExpansions: Infinity,
      maxExpandedLength: Infinity,
    } as unknown as boolean,
  });

  /** Ver a nota do construtor em wsConsultaSqlClient.ts: config, não ambiente. */
  constructor(private readonly cfg: TenantConfig = tenantConfig) {
    this.http = axios.create({
      baseURL: rmSoapConfigurado(cfg) ? `${cfg.rm.conexao.baseUrl}${SERVICE_PATH}` : undefined,
      timeout: 300_000, // ReadView de horário/etapa da filial inteira é pesado
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
      auth: rmSoapConfigurado(cfg)
        ? { username: cfg.rm.conexao.usuario as string, password: cfg.rm.conexao.senha as string }
        : undefined,
    });
  }

  /** Contexto exigido em toda chamada. Um só CODFILIAL — "ALL" não vale aqui. */
  private contexto(codFilial: string): string {
    return [
      `CODCOLIGADA=${this.cfg.rm.escopo.coligada}`,
      `CODFILIAL=${codFilial}`,
      'CODTIPOCURSO=1',
      `CODSISTEMA=${this.cfg.rm.conexao.sistema}`,
    ].join(';');
  }

  /**
   * Lê uma visão de DataServer.
   *
   * @param dataServer  nome exato, ex.: 'EduHorarioTurmaData'.
   * @param filtro      condição SQL com nomes QUALIFICADOS
   *                    (`SHorarioTurma.CODFILIAL=2`). Sem qualificar dá
   *                    "Ambiguous column name".
   * @param rowElement  nome do elemento-linha na resposta, em case misto
   *                    (ex.: 'SHorarioTurma'). Ver armadilha 2 no topo.
   * @param codFilial   campus. Obrigatório e único, por decisão de escopo.
   */
  async readView(
    dataServer: string,
    filtro: string,
    rowElement: string,
    codFilial: string,
  ): Promise<DataServerRow[]> {
    if (!rmSoapConfigurado(this.cfg)) {
      throw new RmDataServerError(
        'wsDataServer não configurado (RM_WS_BASEURL/RM_WS_USER/RM_WS_PASS no .env).',
        dataServer,
      );
    }

    const body =
      '<?xml version="1.0" encoding="utf-8"?>' +
      `<soap:Envelope xmlns:soap="${SOAP_NS}" xmlns:tot="${TOTVS_NS}">` +
      '<soap:Body><tot:ReadView>' +
      `<tot:DataServerName>${escapeXml(dataServer)}</tot:DataServerName>` +
      `<tot:Filtro>${escapeXml(filtro)}</tot:Filtro>` +
      `<tot:Contexto>${escapeXml(this.contexto(codFilial))}</tot:Contexto>` +
      '</tot:ReadView></soap:Body></soap:Envelope>';

    logger.debug({ dataServer, filtro, codFilial }, 'wsDataServer ReadView');

    let raw: string;
    try {
      const res = await this.http.post<string>('', body, {
        responseType: 'text',
        headers: { SOAPAction: `${TOTVS_NS}IwsDataServer/ReadView` },
      });
      raw = res.data;
    } catch (error) {
      if (axios.isAxiosError(error) && typeof error.response?.data === 'string') {
        throw new RmDataServerError(
          `ReadView ${dataServer} falhou: ${this.extractFault(error.response.data)}`,
          dataServer,
        );
      }
      throw error;
    }

    this.assertNoRmError(raw, dataServer, 'ReadView');
    return this.extractRows(raw, rowElement);
  }

  /**
   * Devolve o XSD que o DataServer declara. É a forma segura de descobrir a
   * gramática de um SaveRecord: declara campos, tipos, obrigatoriedade e a
   * chave primária, sem tentativa-e-erro contra dados reais.
   */
  async getSchema(dataServer: string, codFilial: string): Promise<string> {
    if (!rmSoapConfigurado(this.cfg)) {
      throw new RmDataServerError('wsDataServer não configurado.', dataServer);
    }

    const body =
      '<?xml version="1.0" encoding="utf-8"?>' +
      `<soap:Envelope xmlns:soap="${SOAP_NS}" xmlns:tot="${TOTVS_NS}">` +
      '<soap:Body><tot:GetSchema>' +
      `<tot:DataServerName>${escapeXml(dataServer)}</tot:DataServerName>` +
      `<tot:Contexto>${escapeXml(this.contexto(codFilial))}</tot:Contexto>` +
      '</tot:GetSchema></soap:Body></soap:Envelope>';

    const res = await this.http.post<string>('', body, {
      responseType: 'text',
      headers: { SOAPAction: `${TOTVS_NS}IwsDataServer/GetSchema` },
    });
    this.assertNoRmError(res.data, dataServer, 'GetSchema');
    return res.data;
  }

  /**
   * HTTP 200 NÃO é sucesso no RM. Falha vem como SOAP Fault (que o axios pode
   * entregar com 200 dependendo do caso) ou como mensagem no corpo do resultado.
   *
   * Distinção que importa: "Classe ... não encontrada" = o DataServer não existe
   * nesta instalação. Qualquer outra mensagem = ele existe e recusou a chamada.
   * Tratar as duas como a mesma coisa foi o erro que fez este projeto concluir
   * "impossível" sobre um canal que estava exposto.
   */
  private assertNoRmError(raw: string, dataServer: string, operacao: string): void {
    const parsed = this.parser.parse(raw);
    const fault = parsed?.Envelope?.Body?.Fault;
    if (fault) {
      const msg = String(fault?.faultstring ?? fault?.Reason?.Text ?? JSON.stringify(fault));
      const inexistente = /Classe[^]*?n[ãa]o (foi )?encontrad/i.test(msg);
      throw new RmDataServerError(
        `${operacao} ${dataServer}: ${inexistente ? 'DataServer NÃO EXISTE nesta instalação — ' : ''}` +
          msg.replace(/\s+/g, ' ').slice(0, 400),
        dataServer,
      );
    }

    // Erro de negócio sem fault: a mensagem vem no corpo do resultado.
    if (/RM\.Con\.|System\.(Exception|NullReference|Format)|Ocorreu um erro/i.test(raw)) {
      const trecho = raw.replace(/\s+/g, ' ').slice(0, 400);
      throw new RmDataServerError(`${operacao} ${dataServer} devolveu erro no corpo: ${trecho}`, dataServer);
    }
  }

  /**
   * Recorta os elementos-linha do dataset. Faz a busca sem sensibilidade a case
   * (ver armadilha 2) e avisa quando o nome pedido não bate exatamente com o que
   * o RM devolveu — silêncio aqui já custou um levantamento inteiro.
   */
  private extractRows(raw: string, rowElement: string): DataServerRow[] {
    const texto = this.decodeEntities(raw);
    const abre = new RegExp(`<(${rowElement})>`, 'i');
    const achado = abre.exec(texto);
    if (!achado) return [];

    const nomeReal = achado[1];
    if (nomeReal !== rowElement) {
      logger.warn(
        { pedido: rowElement, real: nomeReal },
        'wsDataServer: elemento-linha com case diferente do esperado',
      );
    }

    const blocos = texto.matchAll(new RegExp(`<${nomeReal}>([\\s\\S]*?)</${nomeReal}>`, 'g'));
    const rows: DataServerRow[] = [];
    for (const bloco of blocos) {
      const row: DataServerRow = {};
      for (const campo of bloco[1].matchAll(/<([A-Za-z][A-Za-z0-9_]*)>([\s\S]*?)<\/\1>/g)) {
        row[campo[1]] = campo[2].trim();
      }
      rows.push(row);
    }
    return rows;
  }

  /** O dataset vem escapado dentro do envelope; desescapa antes de recortar. */
  private decodeEntities(raw: string): string {
    return raw
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  private extractFault(rawFault: string): string {
    try {
      const parsed = this.parser.parse(rawFault);
      const fault = parsed?.Envelope?.Body?.Fault;
      const msg = fault?.faultstring ?? fault?.Reason?.Text ?? rawFault;
      return String(msg).replace(/\s+/g, ' ').slice(0, 400);
    } catch {
      return rawFault.slice(0, 400);
    }
  }

  /**
   * `SaveRecord` — a operação de ESCRITA. Uma chamada, um dataset.
   *
   * ─── HTTP 200 NÃO É SUCESSO ─────────────────────────────────────────────
   *
   * O RM devolve erro de negócio com **HTTP 200** e a mensagem dentro de
   * `SaveRecordResult`, muitas vezes com stack trace .NET. Este projeto já se
   * enganou duas vezes com isso — inclusive um script que reportou "o RM aceitou
   * um dataset vazio" porque só procurava `<faultstring>`.
   *
   * Então o sucesso aqui é afirmado por parser ESTRITO, e mesmo assim
   * `ok: true` significa "o RM não reclamou", nunca "o dado está lá". A prova de
   * gravação é reler.
   *
   * ─── TIMEOUT NÃO É FALHA ────────────────────────────────────────────────
   *
   * §9.4 de EduFrequenciaDiariaWSData.md: timeout é `SENT_UNKNOWN`. A escrita
   * pode ter acontecido. Retentar às cegas duplicaria; tratar como falha
   * esconderia. Por isso `desconhecido: true` é um terceiro estado, e quem chama
   * TEM de reler o RM antes de decidir qualquer coisa.
   */
  async saveRecord(
    dataServer: string,
    xmlDataset: string,
    contexto: string,
  ): Promise<{ ok: boolean; desconhecido: boolean; resposta: string }> {
    if (!rmSoapConfigurado(this.cfg)) {
      throw new RmDataServerError('wsDataServer não configurado.', dataServer);
    }

    const body =
      '<?xml version="1.0" encoding="utf-8"?>' +
      `<soap:Envelope xmlns:soap="${SOAP_NS}" xmlns:tot="${TOTVS_NS}">` +
      '<soap:Body><tot:SaveRecord>' +
      `<tot:DataServerName>${escapeXml(dataServer)}</tot:DataServerName>` +
      `<tot:XML>${escapeXml(xmlDataset)}</tot:XML>` +
      `<tot:Contexto>${escapeXml(contexto)}</tot:Contexto>` +
      '</tot:SaveRecord></soap:Body></soap:Envelope>';

    let texto: string;
    try {
      const res = await this.http.post('', body, {
        headers: { SOAPAction: `${TOTVS_NS}IwsDataServer/SaveRecord` },
      });
      texto = String(res.data ?? '');
    } catch (err) {
      const e = err as { code?: string; message?: string };
      const transitorio =
        e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT' || /timeout|aborted/i.test(e.message ?? '');
      if (transitorio) {
        logger.warn(
          { dataServer, err: e.message },
          'SaveRecord sem resposta — a escrita PODE ter acontecido. Releia o RM antes de reenviar',
        );
        return { ok: false, desconhecido: true, resposta: e.message ?? 'timeout' };
      }
      throw new RmDataServerError(`SaveRecord falhou: ${e.message}`, dataServer);
    }

    const m = /<SaveRecordResult[^>]*>([\s\S]*?)<\/SaveRecordResult>/.exec(texto);
    const resultado = (m?.[1] ?? texto).trim();
    // Erro de negócio do RM: texto longo, stack trace, "não foi encontrada",
    // "inválido". Sucesso costuma ser vazio ou um id curto.
    const pareceErro =
      /erro|error|exception|não foi|nao foi|inválid|invalid|falha|at RM\./i.test(resultado) ||
      resultado.length > 200;
    return { ok: !pareceErro, desconhecido: false, resposta: resultado };
  }
}

/** Instância padrão do tenant do ambiente. Ver a nota em wsConsultaSqlClient.ts. */
export const wsDataServerClient = new WsDataServerClient();
