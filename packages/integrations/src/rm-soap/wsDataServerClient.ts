import axios, { AxiosInstance } from 'axios';
import { XMLParser } from 'fast-xml-parser';
import { env, isRmSoapConfigured, logger } from '@rm-toddle/config';

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
 * ─── POR QUE NÃO EXISTE `saveRecord` AQUI ───────────────────────────────────
 *
 * `SaveRecord` existe no serviço e funciona. Não está implementado neste cliente
 * de propósito: enquanto o shadow mode não tiver validado a projeção, um método
 * de escrita disponível é só uma chamada acidental de distância de alterar
 * registro acadêmico legal. Quando for a hora, ele entra junto com a máquina de
 * aprovação (operation/approval), não antes.
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

  constructor() {
    this.http = axios.create({
      baseURL: isRmSoapConfigured ? `${env.RM_WS_BASEURL}${SERVICE_PATH}` : undefined,
      timeout: 300_000, // ReadView de horário/etapa da filial inteira é pesado
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
      auth: isRmSoapConfigured
        ? { username: env.RM_WS_USER as string, password: env.RM_WS_PASS as string }
        : undefined,
    });
  }

  /** Contexto exigido em toda chamada. Um só CODFILIAL — "ALL" não vale aqui. */
  private contexto(codFilial: string): string {
    return [
      `CODCOLIGADA=${env.RM_CODCOLIGADA}`,
      `CODFILIAL=${codFilial}`,
      'CODTIPOCURSO=1',
      `CODSISTEMA=${env.RM_WS_SISTEMA}`,
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
    if (!isRmSoapConfigured) {
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
    if (!isRmSoapConfigured) {
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
}

export const wsDataServerClient = new WsDataServerClient();
