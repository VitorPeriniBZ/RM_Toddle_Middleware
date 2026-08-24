import axios, { AxiosInstance } from 'axios';
import { XMLParser } from 'fast-xml-parser';
import { logger, rmSoapConfigurado, tenantConfig, type TenantConfig } from '@rm-toddle/config';

/**
 * Cliente do TOTVS RM wsConsultaSQL (SOAP 1.1, document/literal).
 *
 * No CloudTOTVS o REST educacional (TTALK) costuma NÃO estar publicado — o que
 * fica exposto é o wsConsultaSQL na porta 1951. Este cliente executa Sentenças
 * SQL previamente cadastradas no RM (RealizarConsultaSQL) e devolve as linhas
 * já normalizadas como objetos { COLUNA: valor }.
 *
 * Contrato do serviço (do WSDL):
 *   endpoint  {RM_WS_BASEURL}/wsConsultaSQL/IwsConsultaSQL
 *   auth      HTTP Basic (usuário do RM) sobre TLS
 *   operação  RealizarConsultaSQL(codSentenca, codColigada, codSistema, parameters)
 *   retorno   string contendo um XML <NewDataSet><Resultado>...</Resultado></NewDataSet>
 *
 * `parameters` é uma string no formato "NOME=valor;NOME2=valor2" — os nomes
 * batem com os parâmetros declarados na própria Sentença no RM.
 */

const SOAP_NS = 'http://schemas.xmlsoap.org/soap/envelope/';
const TOTVS_NS = 'http://www.totvs.com/';
const SOAP_ACTION = 'http://www.totvs.com/IwsConsultaSQL/RealizarConsultaSQL';
const SERVICE_PATH = '/wsConsultaSQL/IwsConsultaSQL';

export type ConsultaRow = Record<string, string>;

/** Escapa os 5 caracteres que quebram um corpo XML. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Serializa {A:1, B:'x'} -> "A=1;B=x" (formato aceito pela Sentença do RM). */
export function buildParameters(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join(';');
}

class WsConsultaSqlClient {
  private readonly http: AxiosInstance;
  // isArray: força Resultado a ser sempre array, mesmo com uma única linha.
  private readonly parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false, // mantém tudo como string; conversão é responsabilidade do chamador
    trimValues: true,
    removeNSPrefix: true,
    isArray: (name) => name === 'Resultado',
    // O dataset do RM vem como XML escapado (milhares de &lt;/&gt;), estourando
    // os limites anti-DoS padrão (1000 expansões / 100k chars). A origem é o
    // próprio RM (confiável), então removemos o teto.
    processEntities: {
      enabled: true,
      maxTotalExpansions: Infinity,
      maxExpandedLength: Infinity,
    } as unknown as boolean,
  });

  /**
   * A config da escola, e não o ambiente, é a fonte da conexão.
   *
   * O default mantém os chamadores existentes funcionando sem mudança — mas todo
   * código NOVO deve passar a config, para nascer capaz de atender mais de uma
   * escola. Sem isto, cada fluxo novo (turma, plano de aula, frequência de
   * volta, nota de volta) seria mais um a refatorar depois.
   */
  constructor(private readonly cfg: TenantConfig = tenantConfig) {
    const configurado = rmSoapConfigurado(cfg);
    // baseURL só é montada se o SOAP estiver configurado — assim o módulo pode
    // ser importado mesmo em ambientes que não usam o RM (ex.: testes do Toddle).
    const baseURL = configurado ? `${cfg.rm.conexao.baseUrl}${SERVICE_PATH}` : undefined;
    this.http = axios.create({
      baseURL,
      timeout: 120_000, // Sentenças pesadas (roster inteiro) podem demorar
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: SOAP_ACTION,
      },
      auth: configurado
        ? { username: cfg.rm.conexao.usuario as string, password: cfg.rm.conexao.senha as string }
        : undefined,
    });
  }

  /**
   * Executa uma Sentença cadastrada e devolve as linhas do dataset.
   * @param codSentenca código da Sentença SQL no RM (ex.: "TODDLE.STUDENTS").
   * @param params      parâmetros da Sentença (além de CODCOLIGADA/CODSISTEMA).
   */
  async realizarConsulta(
    codSentenca: string,
    params: Record<string, string | number> = {},
  ): Promise<ConsultaRow[]> {
    if (!rmSoapConfigurado(this.cfg)) {
      throw new Error(
        'wsConsultaSQL não configurado (RM_WS_BASEURL/RM_WS_USER/RM_WS_PASS no .env).',
      );
    }

    const parameters = buildParameters(params);
    const body = this.buildEnvelope(codSentenca, parameters);

    logger.debug({ codSentenca, parameters }, 'wsConsultaSQL RealizarConsultaSQL');

    let raw: string;
    try {
      const res = await this.http.post<string>('', body, { responseType: 'text' });
      raw = res.data;
    } catch (error) {
      // Um SOAP Fault volta com HTTP 500 e o XML do fault no corpo.
      if (axios.isAxiosError(error) && typeof error.response?.data === 'string') {
        throw new Error(
          `wsConsultaSQL falhou (${codSentenca}): ${this.extractFault(error.response.data)}`,
        );
      }
      throw error;
    }

    return this.parseResult(raw, codSentenca);
  }

  private buildEnvelope(codSentenca: string, parameters: string): string {
    return (
      '<?xml version="1.0" encoding="utf-8"?>' +
      `<soap:Envelope xmlns:soap="${SOAP_NS}" xmlns:tot="${TOTVS_NS}">` +
      '<soap:Body>' +
      '<tot:RealizarConsultaSQL>' +
      `<tot:codSentenca>${escapeXml(codSentenca)}</tot:codSentenca>` +
      `<tot:codColigada>${this.cfg.rm.escopo.coligada}</tot:codColigada>` +
      `<tot:codSistema>${escapeXml(this.cfg.rm.conexao.sistema)}</tot:codSistema>` +
      `<tot:parameters>${escapeXml(parameters)}</tot:parameters>` +
      '</tot:RealizarConsultaSQL>' +
      '</soap:Body>' +
      '</soap:Envelope>'
    );
  }

  /**
   * O retorno vem duplamente empacotado: o envelope SOAP contém
   * RealizarConsultaSQLResult, que é uma STRING com o XML do dataset. O parser
   * decodifica as entidades (&lt; etc.) automaticamente, então parseamos de novo.
   */
  private parseResult(rawEnvelope: string, codSentenca: string): ConsultaRow[] {
    const envelope = this.parser.parse(rawEnvelope);
    const body = envelope?.Envelope?.Body;

    if (body?.Fault) {
      const fault = body.Fault;
      const msg = fault?.faultstring ?? fault?.Reason?.Text ?? JSON.stringify(fault);
      throw new Error(`wsConsultaSQL SOAP Fault (${codSentenca}): ${msg}`);
    }

    const resultXml: unknown = body?.RealizarConsultaSQLResponse?.RealizarConsultaSQLResult;
    if (resultXml == null || resultXml === '') return []; // dataset vazio

    const dataset = this.parser.parse(String(resultXml));
    const rows = dataset?.NewDataSet?.Resultado;
    if (!rows) return [];

    // isArray garante array; ainda assim normalizamos valores para string.
    return (rows as Array<Record<string, unknown>>).map((row) => {
      const clean: ConsultaRow = {};
      for (const [key, value] of Object.entries(row)) {
        clean[key] = value == null ? '' : String(value).trim();
      }
      return clean;
    });
  }

  /** Extrai a mensagem de um SOAP Fault para um erro legível. */
  private extractFault(rawFault: string): string {
    try {
      const parsed = this.parser.parse(rawFault);
      const fault = parsed?.Envelope?.Body?.Fault;
      return fault?.faultstring ?? fault?.Reason?.Text ?? rawFault.slice(0, 500);
    } catch {
      return rawFault.slice(0, 500);
    }
  }
}

/**
 * Instância padrão, ligada à escola que este processo atende.
 *
 * Ponte para os chamadores existentes. Quando houver mais de uma escola no mesmo
 * processo, construa `new WsConsultaSqlClient(cfg)` por tenant em vez de usar
 * esta — ela continuará servindo o tenant do ambiente.
 */
export const wsConsultaSqlClient = new WsConsultaSqlClient();
