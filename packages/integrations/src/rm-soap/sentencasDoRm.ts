import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger, tenantConfig, type TenantConfig } from '@rm-toddle/config';
import { wsConsultaSqlClient } from './wsConsultaSqlClient';
import { wsDataServerClient } from './wsDataServerClient';

/**
 * RESTAURAÇÃO DAS SENTENÇAS DO RM — a carga inicial, e o que prova que deu certo.
 *
 * ─── O PROBLEMA ────────────────────────────────────────────────────────────
 *
 * Sentença é DADO, não configuração de servidor: mora em `GCONSSQL` e
 * `GCONSSQLPARAMETROS`. Toda cópia de base por cima do ambiente leva as seis
 * junto — aconteceu em 13–15/08/2026 e de novo em 16/09/2026. Sem elas, todo
 * fluxo de leitura do RM para de existir, porque não há outra fonte.
 *
 * O repositório sempre teve os `.sql`. O que faltava era o caminho de volta.
 *
 * ─── O CANAL EXISTE, E FOI MEDIDO ──────────────────────────────────────────
 *
 * `GlbConsSQLData` no `wsDataServer` (mesma porta 1951) expõe `SaveRecord`.
 * Sondado em 16/09/2026 numa Sentença descartável (`TODDLE.SONDA`, apagada
 * depois): gravou, devolveu a chave `1;S;TODDLE.SONDA`, gerou `GUID` e
 * `CONTROLE` sozinho, e a Sentença EXECUTOU pelo `wsConsultaSQL` com a
 * credencial da integração.
 *
 * ─── POR QUE `ok` NÃO É SUFICIENTE, E NUNCA SERÁ ───────────────────────────
 *
 * O modo de falha desta casa não é o RM recusar — é ele ACEITAR e o dado ficar
 * sutilmente errado, sem erro. `EduNotaEtapaData` respondeu `ok=true` e
 * descartou a nota. Uma Sentença aceita e silenciosamente truncada, ou com uma
 * coluna a menos, é pior: ela alimenta TODOS os fluxos, e coluna que não existe
 * chega no middleware como `undefined`, indistinguível de "o RM não tem esse
 * dado". Foi assim que cinco professores ficaram sem e-mail por semanas.
 *
 * Então aqui `restaurar()` não devolve "ok". Devolve o resultado de TRÊS
 * camadas, e só as três juntas autorizam dizer que a Sentença voltou:
 *
 *   1. RELEITURA  — `ReadRecord` e compara o corpo caractere a caractere com o
 *                   `.sql`. Pega truncamento e `:NOME` virando `@NOME`.
 *   2. EXECUÇÃO   — roda pelo `wsConsultaSQL`, com a credencial DA INTEGRAÇÃO
 *                   (não a de quem clicou), e confere que voltaram TODAS as
 *                   colunas que o `.sql` declara. Pega `SEMSEGCOLUNAS` mal
 *                   gravado, que faz o RM remover coluna sem avisar.
 *   3. VOLUME     — conta as linhas. Zero linhas com Sentença existente é o
 *                   outro silêncio: a Sentença voltou, o dado não.
 *
 * ─── `TAMANHO` É CALCULADO, NUNCA COPIADO DO MANIFESTO ─────────────────────
 *
 * O RM conta o corpo em CRLF. Medido em 16/09/2026 nas seis: quatro batem
 * exatamente com `len(corpo com CRLF)`; `TODDLE.NOTAS` diverge em 168 e
 * `TODDLE.FREQ` em 2, porque o `exportar-sentencas.sh` compara os `.sql` sem
 * sensibilidade a espaço (`split()`) e não reescreveu arquivos que mudaram só na
 * indentação — o `TAMANHO` do manifesto é do corpo ANTIGO.
 *
 * Copiar esse número mandaria ao RM um tamanho que não corresponde ao texto, que
 * é exatamente o que o README avisa que TRUNCA o SQL. Então calculamos do corpo
 * que estamos enviando, e pronto.
 */

const DATA_SERVER = 'GlbConsSQLData';
/** `GlbConsSQLData` quer só estes dois. `CODFILIAL` aqui faz o RM recusar. */
const contextoDeSentenca = (coligada: string | number): string => `CODCOLIGADA=${coligada};CODSISTEMA=G`;

/** A pasta é a MESMA que o `exportar-sentencas.sh` lê e escreve. Uma fonte só. */
const PASTA = resolve(__dirname, '../../../../docs/rm-sentencas');
const MANIFESTO = resolve(PASTA, 'sentencas.manifesto.json');

export const SENTENCAS_DO_TODDLE = [
  'TODDLE.STUDENTS',
  'TODDLE.TURMADISC',
  'TODDLE.RESP',
  'TODDLE.FREQ',
  'TODDLE.NOTAS',
  'TODDLE.PLANOAULA',
] as const;

export type CodigoDeSentenca = (typeof SENTENCAS_DO_TODDLE)[number];

/*
 * NÃO EXISTE BASELINE DE LINHAS AQUI, E É DE PROPÓSITO.
 *
 * A primeira versão trazia os números medidos em 11/09/2026 (597 alunos, 672
 * turma-disciplina, 7.283 notas) e mostrava "603 linhas (baseline: 597)" ao
 * lado de cada Sentença. Está errado como engenharia: a base é um sistema vivo,
 * matrícula entra, nota é lançada todo dia, e um número congelado no código
 * diverge do real na primeira semana. Uma tela que acusa diferença toda vez que
 * a escola funciona ensina a ignorar a tela.
 *
 * O invariante que vale para sempre é OUTRO: a Sentença tem de devolver MAIS QUE
 * ZERO. Zero linha com a Sentença cadastrada é o silêncio que importa — ela
 * existe, o dado não. Isso não caduca, não precisa de manutenção e não dispara
 * sozinho.
 *
 * Se um dia for preciso detectar queda brusca de volume, a comparação tem de ser
 * contra a ÚLTIMA execução observada (em `job_run`, que já guarda histórico), e
 * não contra um literal que alguém teria de vir atualizar à mão.
 */

/**
 * As duas de janela de data não cabem numa resposta só no ano inteiro, então o
 * smoke test usa uma janela curta. Volume aqui não diz nada sobre o ano — diz
 * que a Sentença executa e devolve as colunas certas, que é o que se está
 * conferindo.
 */
const PEDE_JANELA: ReadonlySet<string> = new Set(['TODDLE.FREQ', 'TODDLE.PLANOAULA']);

export interface MetadadosDeSentenca {
  TITULO?: string | null;
  DISPONIVELFILTRO?: string | null;
  DISPONIVELRELATORIO?: string | null;
  DISPONIVELVISAO?: string | null;
  DISPONIVELMENU?: string | null;
  SEMSEGCOLUNAS?: string | null;
  SEMSEGESTENDIDA?: string | null;
  PARAMETROS?: Array<{ NOME: string; DESCRICAO: string | null; TIPO: string | null }>;
}

export interface SentencaNoDisco {
  codigo: CodigoDeSentenca;
  /** Corpo como está no `.sql`, com LF. O envio converte para CRLF. */
  corpo: string;
  metadados: MetadadosDeSentenca;
  /** Colunas que o `SELECT` declara — o contrato que a execução tem de honrar. */
  colunasEsperadas: string[];
}

/** `null` quando falta o `.sql` ou a entrada no manifesto. */
export function lerDoDisco(codigo: CodigoDeSentenca): SentencaNoDisco | null {
  const arquivo = resolve(PASTA, `${codigo}.sql`);
  if (!existsSync(arquivo) || !existsSync(MANIFESTO)) return null;

  const corpo = readFileSync(arquivo, 'utf8').replace(/\r\n/g, '\n');
  const manifesto = JSON.parse(readFileSync(MANIFESTO, 'utf8')) as Record<string, MetadadosDeSentenca>;
  const metadados = manifesto[codigo];
  if (!metadados) return null;

  return { codigo, corpo, metadados, colunasEsperadas: colunasDo(corpo) };
}

/**
 * Colunas declaradas na lista do `SELECT`.
 *
 * Corta no primeiro `FROM` em início de linha para não pegar alias de subquery,
 * e exige que o alias termine a expressão (`,` ou fim de linha) — é o que
 * separa `AS EMAIL_PROFESSOR` de `CAST(:DATAINICIAL AS VARCHAR(8))`.
 *
 * Conferido nas seis em 16/09/2026: 21, 20, 12, 26, 27 e 32 colunas, todas
 * batendo com o que o `.sql` lista.
 */
export function colunasDo(corpo: string): string[] {
  const from = /^\s*FROM\b/im.exec(corpo);
  const lista = from ? corpo.slice(0, from.index) : corpo;
  return [...lista.matchAll(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?=,|$)/gim)].map((m) => m[1].toUpperCase());
}

/**
 * O CONTEÚDO DE UM CAMPO VEM ESCAPADO DUAS VEZES, E ISSO NÃO É DETALHE.
 *
 * O envelope SOAP carrega o dataset como texto escapado (1ª camada), e dentro do
 * dataset o corpo do SQL está escapado de novo (2ª camada) — porque ele tem
 * `<`, `>` e `&`. O `readRecord` desfaz a primeira; esta desfaz a segunda.
 *
 * Medido em 16/09/2026: sem ela, `F.DATA >= ...` volta como `F.DATA &gt;= ...`,
 * a comparação com o `.sql` reprova, e a conclusão é "o RM guardou o SQL
 * corrompido" — sobre uma Sentença que estava perfeita e executando. O
 * `exportar-sentencas.sh` sempre soube disso: ele chama `html.unescape` DUAS
 * vezes, e a linha passou despercebida na primeira leitura.
 *
 * `&amp;` por último, senão `&amp;lt;` viraria `<` em vez de `&lt;`.
 */
function desescapar(valor: string): string {
  return valor
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&');
}

/** As flags que decidem, sozinhas, se a execução vai devolver tudo. */
export interface FlagsDaSentenca {
  SEMSEGCOLUNAS: string | null;
  SEMSEGESTENDIDA: string | null;
}

/** O que o RM tem hoje, ou `null` se a chave não existe. */
export async function lerDoRm(
  codigo: CodigoDeSentenca,
  cfg: TenantConfig = tenantConfig,
): Promise<{
  corpo: string;
  tamanho: string | null;
  alteradoEm: string | null;
  flags: FlagsDaSentenca;
} | null> {
  const coligada = cfg.rm.escopo.coligada;
  const dataset = await wsDataServerClient.readRecord(
    DATA_SERVER,
    `${coligada};S;${codigo}`,
    contextoDeSentenca(coligada),
  );
  if (!dataset) return null;

  const campo = (k: string): string | null => {
    const m = new RegExp(`<${k}>([\\s\\S]*?)</${k}>`).exec(dataset);
    return m ? desescapar(m[1]) : null;
  };
  // Verbatim, menos CRLF: as linhas em branco fazem parte do corpo colável, e
  // aparar aqui criaria divergência onde não há.
  const corpo = (campo('SENTENCA') ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return {
    corpo,
    tamanho: campo('TAMANHO'),
    alteradoEm: campo('DTULTALTERACAO'),
    flags: { SEMSEGCOLUNAS: campo('SEMSEGCOLUNAS'), SEMSEGESTENDIDA: campo('SEMSEGESTENDIDA') },
  };
}

function xml(tag: string, valor: string | number): string {
  const texto = String(valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<${tag}>${texto}</${tag}>`;
}

/**
 * Monta o dataset do `SaveRecord`.
 *
 * NÃO manda `GUID`, `CONTROLE`, `DTULTALTERACAO` nem `USRULTALTERACAO`: medido
 * na sonda, o RM gera os quatro. Mandar os do manifesto plantaria o GUID de um
 * registro que não existe mais e a data de alteração de agosto num registro
 * criado hoje — dado errado que ninguém questionaria depois.
 *
 * Os `DISPONIVEL*` e os dois `SEMSEG*` VÃO, e são o motivo de o manifesto
 * existir: `SEMSEGCOLUNAS` diferente faz o RM devolver menos colunas em silêncio.
 */
export function datasetDeGravacao(s: SentencaNoDisco, coligada: string | number): string {
  const corpoCrlf = s.corpo.replace(/\n/g, '\r\n');
  const m = s.metadados;
  const flag = (valor: string | null | undefined, padrao: string): string => valor ?? padrao;

  const cabecalho =
    '<GConsSql>' +
    xml('CODCOLIGADA', coligada) +
    xml('APLICACAO', 'S') +
    xml('CODSENTENCA', s.codigo) +
    xml('TITULO', m.TITULO ?? s.codigo) +
    xml('SENTENCA', corpoCrlf) +
    xml('TAMANHO', corpoCrlf.length) +
    xml('DISPONIVELFILTRO', flag(m.DISPONIVELFILTRO, '1')) +
    xml('DISPONIVELRELATORIO', flag(m.DISPONIVELRELATORIO, '1')) +
    xml('DISPONIVELVISAO', flag(m.DISPONIVELVISAO, '1')) +
    xml('DISPONIVELMENU', flag(m.DISPONIVELMENU, '0')) +
    xml('SEMSEGCOLUNAS', flag(m.SEMSEGCOLUNAS, '0')) +
    xml('SEMSEGESTENDIDA', flag(m.SEMSEGESTENDIDA, '0')) +
    '</GConsSql>';

  // `TIPO` nulo no manifesto é NULL no banco, e assim as seis EXECUTAM. Não é
  // para "consertar" para System.String junto de uma restauração: o que está
  // documentado funcionando é isto.
  const params = (m.PARAMETROS ?? [])
    .map(
      (p) =>
        '<GConsSqlParams>' +
        xml('CODCOLIGADA', coligada) +
        xml('APLICACAO', 'S') +
        xml('CODSENTENCA', s.codigo) +
        xml('NOME', p.NOME) +
        (p.DESCRICAO === null || p.DESCRICAO === undefined ? '' : xml('DESCRICAO', p.DESCRICAO)) +
        (p.TIPO === null || p.TIPO === undefined ? '' : xml('TIPO', p.TIPO)) +
        '</GConsSqlParams>',
    )
    .join('');

  return `<GlbConsSql>${cabecalho}${params}</GlbConsSql>`;
}

/** Parâmetros do smoke test. As de janela levam um intervalo curto de propósito. */
function parametrosDeExecucao(codigo: CodigoDeSentenca, cfg: TenantConfig): Record<string, string> {
  const params: Record<string, string> = {
    CODCOLIGADA: String(cfg.rm.escopo.coligada),
    CODPERLET: cfg.rm.escopo.periodoLetivo ?? '',
  };
  if (PEDE_JANELA.has(codigo)) {
    const hoje = new Date();
    const inicio = new Date(hoje.getTime() - 7 * 24 * 3600 * 1000);
    const estilo112 = (d: Date): string =>
      `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    params.DATAINICIAL = estilo112(inicio);
    params.DATAFINAL = estilo112(hoje);
  }
  return params;
}

export type CamadaDeAceite = 'releitura' | 'execucao' | 'volume';

export interface ConferenciaDeSentenca {
  codigo: CodigoDeSentenca;
  existeNoRm: boolean;
  /** `true` só quando as três camadas passam. */
  confere: boolean;
  /**
   * `false` quando só a releitura rodou. Sem isto, "não conferi a execução" e
   * "a execução reprovou" chegariam na tela com a mesma cara — e a tela diria
   * vermelho para uma Sentença possivelmente boa, ou pior, alguém leria o
   * vermelho como ruído e pararia de olhar.
   */
  verificacaoCompleta: boolean;
  releitura: { ok: boolean; detalhe: string };
  execucao: { ok: boolean; detalhe: string; colunasAusentes: string[] };
  volume: { ok: boolean; linhas: number | null; detalhe: string };
  /** Primeira camada que reprovou, para a tela nomear o problema. */
  reprovouEm: CamadaDeAceite | null;
  /**
   * Aviso que NÃO reprova, porque não dá para provar pelo dado. Ver o comentário
   * de `colunasAusentes` em `conferir`.
   */
  aviso: string | null;
}

/**
 * As três camadas, sem gravar nada. É o que a restauração chama depois de
 * gravar, e o que o botão de conferir chama sozinho.
 *
 * Camadas 2 e 3 só rodam se a 1 passar: executar um corpo que já se sabe errado
 * gastaria uma consulta pesada para reprovar pelo mesmo motivo.
 *
 * ─── `executar: false` É A CAMADA 1 SOZINHA ────────────────────────────────
 *
 * A tela abre com ela. Não é economia de estilo: conferir as seis de verdade
 * roda a `TODDLE.NOTAS`, que devolve ~7 mil linhas por SOAP, e uma tela que
 * demora meio minuto para abrir é uma tela que ninguém abre. Quando a execução
 * não roda, o resultado diz `não executada` em vez de fingir aprovação — é a
 * diferença entre "não verifiquei" e "está bom", e confundir as duas é como
 * nasce um painel verde sobre um sistema parado.
 */
export async function conferir(
  codigo: CodigoDeSentenca,
  cfg: TenantConfig = tenantConfig,
  opcoes: { executar?: boolean } = {},
): Promise<ConferenciaDeSentenca> {
  const executar = opcoes.executar ?? true;
  const vazio = (detalhe: string): ConferenciaDeSentenca => ({
    codigo,
    existeNoRm: false,
    confere: false,
    verificacaoCompleta: true,
    releitura: { ok: false, detalhe },
    execucao: { ok: false, detalhe: 'não executada', colunasAusentes: [] },
    volume: { ok: false, linhas: null, detalhe: 'não contado' },
    reprovouEm: 'releitura',
    aviso: null,
  });

  const disco = lerDoDisco(codigo);
  if (!disco) return vazio(`sem ${codigo}.sql ou sem entrada no manifesto — não há de onde restaurar`);

  const noRm = await lerDoRm(codigo, cfg);
  if (!noRm) return vazio('não existe no RM');

  // Caractere a caractere, e não `split()` como o exportar-sentencas.sh faz: é
  // justamente a comparação frouxa de lá que deixou dois TAMANHO velhos no
  // manifesto sem ninguém ver.
  const corpoIgual = noRm.corpo.trimEnd() === disco.corpo.trimEnd();

  /*
   * AS FLAGS ENTRAM NA RELEITURA, E NÃO NA EXECUÇÃO, DE PROPÓSITO.
   *
   * `SEMSEGCOLUNAS` e `SEMSEGESTENDIDA` são a CAUSA conhecida de o RM devolver
   * menos coluna ou menos linha sem erro nenhum. Conferi-las é determinístico —
   * ou o valor gravado é o do manifesto, ou não é. Tentar detectar o mesmo
   * problema olhando o dado que voltou não é determinístico, e foi por aí que
   * esta conferência começou dando falso positivo.
   */
  const flagEsperada = (k: 'SEMSEGCOLUNAS' | 'SEMSEGESTENDIDA'): string => disco.metadados[k] ?? '0';
  const flagsDiferentes = (['SEMSEGCOLUNAS', 'SEMSEGESTENDIDA'] as const).filter(
    (k) => (noRm.flags[k] ?? '0') !== flagEsperada(k),
  );

  const igual = corpoIgual && flagsDiferentes.length === 0;
  const releitura = {
    ok: igual,
    detalhe: !corpoIgual
      ? `corpo DIFERENTE do .sql (RM: ${noRm.corpo.length}, repo: ${disco.corpo.length} caracteres)`
      : flagsDiferentes.length > 0
        ? `corpo ok, mas ${flagsDiferentes
            .map((k) => `${k}=${noRm.flags[k] ?? 'NULL'} (esperado ${flagEsperada(k)})`)
            .join(' e ')} — com isso o RM remove coluna ou linha sem avisar`
        : `idêntico ao .sql (${disco.corpo.length} car.) · flags ok`,
  };

  if (!igual || !executar) {
    return {
      codigo,
      existeNoRm: true,
      confere: false,
      verificacaoCompleta: !igual,
      releitura,
      execucao: {
        ok: false,
        colunasAusentes: [],
        detalhe: igual ? 'não executada — só a releitura foi pedida' : 'não executada — o corpo já diverge',
      },
      volume: { ok: false, linhas: null, detalhe: 'não contado' },
      reprovouEm: igual ? null : 'releitura',
      aviso: null,
    };
  }

  let linhas: Array<Record<string, string>> = [];
  let erroDeExecucao: string | null = null;
  try {
    /*
     * `recuperar: false`: esta execução é a PROVA de que a Sentença voltou
     * funcionando, e prova não pode se consertar sozinha. Sem a trava, uma
     * Sentença que continua falhando depois de recolocada mandaria o cliente
     * restaurá-la de novo — e este mesmo `conferir` rodaria outra vez, para
     * sempre. Ver `autoRestauro.ts`.
     */
    linhas = await wsConsultaSqlClient.realizarConsulta(codigo, parametrosDeExecucao(codigo, cfg), {
      recuperar: false,
    });
  } catch (e) {
    erroDeExecucao = e instanceof Error ? e.message : String(e);
  }

  /*
   * A UNIÃO DE TODAS AS LINHAS, NUNCA A PRIMEIRA.
   *
   * O dataset do .NET OMITE o elemento da coluna que está nula naquela linha.
   * Olhar só `linhas[0]` acusa como "coluna removida" toda coluna que por acaso
   * é nula no primeiro aluno — medido em 16/09/2026: a `TODDLE.RESP` acusava
   * `EMAIL_ACAD_PESSOAL` e `PARENTESCO_ACADEMICO` faltando, e as duas estão lá,
   * nulas só na primeira linha.
   *
   * E POR QUE ISSO NÃO REPROVA. Mesmo na união, coluna ausente é ambígua: pode
   * ter sido removida pela segurança, ou estar nula nas 603 linhas. A API não
   * devolve schema, então não há como separar as duas pelo dado. Quem decide a
   * causa é a checagem de flags, na releitura, que é determinística. Aqui fica
   * como AVISO nomeado — informação para quem olha, não um vermelho que ensina
   * a ignorar vermelho.
   */
  const uniao = new Set<string>();
  for (const linha of linhas) for (const k of Object.keys(linha)) uniao.add(k.toUpperCase());
  const colunasAusentes = linhas.length > 0 ? disco.colunasEsperadas.filter((c) => !uniao.has(c)) : [];

  /*
   * CONTA AS ESPERADAS QUE VOLTARAM — NUNCA O TAMANHO DA UNIÃO.
   *
   * A primeira versão comparava `uniao.size` com `colunasEsperadas.length`, que
   * são conjuntos DIFERENTES: a união tem toda coluna que o RM devolveu, e as
   * esperadas saem dos apelidos `AS` do `.sql`. Coluna sem apelido explícito
   * entra numa e não na outra.
   *
   * Na tela isso apareceu como "devolveu 13 das 12 colunas" na `TODDLE.RESP`, e
   * como "20 das 20 colunas" na `TURMADISC` ao lado do aviso de que
   * `AULAS_SEMANAIS` não veio — duas frases que se contradizem na mesma linha.
   * Um painel que se contradiz é pior que um painel que falta: ele gasta o
   * crédito de quem lê.
   */
  const presentes = disco.colunasEsperadas.length - colunasAusentes.length;
  const execucao = {
    ok: erroDeExecucao === null,
    detalhe:
      erroDeExecucao !== null
        ? `o RM recusou executar: ${erroDeExecucao.slice(0, 200)}`
        : linhas.length === 0
          ? 'executou sem erro, mas veio vazia (ver retorno)'
          : colunasAusentes.length === 0
            ? `executou e devolveu as ${disco.colunasEsperadas.length} colunas do .sql`
            : `executou e devolveu ${presentes} das ${disco.colunasEsperadas.length} colunas do .sql`,
    colunasAusentes,
  };

  const volume = {
    ok: erroDeExecucao === null && linhas.length > 0,
    linhas: erroDeExecucao === null ? linhas.length : null,
    detalhe:
      erroDeExecucao !== null
        ? 'não contado — a execução falhou'
        : linhas.length === 0
          ? 'ZERO linhas: a Sentença existe, o dado não. Confira o CODPERLET e se a cópia trouxe o período letivo'
          : `${linhas.length} linhas`,
  };

  const reprovouEm: CamadaDeAceite | null = !releitura.ok
    ? 'releitura'
    : !execucao.ok
      ? 'execucao'
      : !volume.ok
        ? 'volume'
        : null;

  return {
    codigo,
    existeNoRm: true,
    confere: reprovouEm === null,
    verificacaoCompleta: true,
    releitura,
    execucao,
    volume,
    reprovouEm,
    /*
     * O aviso nomeia as COLUNAS, e não o tamanho do resultado. Dizer "não vieram
     * em nenhuma das 603 linhas" amarra a frase a um número que muda a cada
     * execução e não acrescenta nada: quem lê precisa saber QUAL coluna veio
     * vazia, não quantas linhas tinha o resultado daquele instante.
     */
    /*
     * SÓ O FATO. A explicação — "provavelmente coluna nula, mas nula chega como
     * undefined no middleware" — é idêntica para todas as Sentenças, e repetida
     * linha a linha virou três linhas de texto igual em cinco das seis, que é o
     * tipo de ruído que faz parar de ler a coluna inteira. Ela passou a viver
     * UMA vez, embaixo da tabela.
     */
    aviso: colunasAusentes.length > 0 ? `sem valor em todo o resultado: ${colunasAusentes.join(', ')}` : null,
  };
}

export interface RestauracaoDeSentenca extends ConferenciaDeSentenca {
  /** `false` quando já estava lá e conferindo — nada foi enviado. */
  gravou: boolean;
  /** Timeout no SaveRecord: pode ter gravado. A conferência é quem decide. */
  desconhecido: boolean;
  respostaDoRm: string | null;
}

/**
 * Grava a Sentença no RM e prova que ela voltou.
 *
 * Idempotente por conferência, não por flag: se as três camadas já passam, não
 * envia nada. É o que torna o botão seguro de clicar duas vezes.
 */
export async function restaurar(
  codigo: CodigoDeSentenca,
  cfg: TenantConfig = tenantConfig,
): Promise<RestauracaoDeSentenca> {
  const antes = await conferir(codigo, cfg);
  if (antes.confere) {
    return { ...antes, gravou: false, desconhecido: false, respostaDoRm: null };
  }

  const disco = lerDoDisco(codigo);
  if (!disco) {
    return { ...antes, gravou: false, desconhecido: false, respostaDoRm: null };
  }

  const coligada = cfg.rm.escopo.coligada;
  const resultado = await wsDataServerClient.saveRecord(
    DATA_SERVER,
    datasetDeGravacao(disco, coligada),
    contextoDeSentenca(coligada),
  );

  logger.info(
    { codigo, ok: resultado.ok, desconhecido: resultado.desconhecido },
    'SaveRecord de Sentença enviado — a conferência é que decide',
  );

  // Relê SEMPRE, inclusive quando o RM disse que não deu certo e quando deu
  // timeout: `ok=false` com a Sentença gravada e `desconhecido` com a gravação
  // feita são os dois casos em que acreditar na resposta mente.
  const depois = await conferir(codigo, cfg);
  return {
    ...depois,
    gravou: true,
    desconhecido: resultado.desconhecido,
    respostaDoRm: resultado.resposta?.slice(0, 300) ?? null,
  };
}

/** Remove uma Sentença. Existe para a sonda e para desfazer — não para o botão. */
export async function remover(codigo: string, cfg: TenantConfig = tenantConfig): Promise<string> {
  const coligada = cfg.rm.escopo.coligada;
  const dataset =
    '<GlbConsSql><GConsSql>' +
    xml('CODCOLIGADA', coligada) +
    xml('APLICACAO', 'S') +
    xml('CODSENTENCA', codigo) +
    '</GConsSql></GlbConsSql>';
  return wsDataServerClient.deleteRecord(DATA_SERVER, dataset, contextoDeSentenca(coligada));
}
