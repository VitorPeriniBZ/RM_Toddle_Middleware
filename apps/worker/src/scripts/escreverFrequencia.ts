import { configVersion, configVersionDetalhe, env, logger, tenantConfig } from '@rm-toddle/config';
import {
  abrirRun,
  carregarProveniencia,
  chaveDoMapa,
  contarProveniencia,
  estaAprovado,
  fecharRun,
  idMappingRepository,
  pedirAprovacao,
  pgPool,
  registrarEscrita,
  registrarPendencia,
  resumoPendencias,
  type VereditoPendente,
} from '@rm-toddle/db';
import { toddleClient, wsDataServerClient } from '@rm-toddle/integrations';
import {
  avaliarVolume,
  chaveNaturalRm,
  decidirEscrita,
  estadoNoRmDeFalta,
  fetchFrequenciaFromRm,
  hashValor,
  indexaFaltasPorChave,
  montaLotes,
  PeriodTimeIndex,
  projetaLote,
  resumirDecisoes,
  RmAttendanceTargets,
  type ContextoProjecao,
  type Decisao,
  type LoteFrequencia,
  type Projetado,
} from '@rm-toddle/domain';

/** Config da escola atendida por este processo. */
const cfg = tenantConfig;

/**
 * ESCREVE a frequência do Toddle no TOTVS RM. A via de volta, de verdade.
 *
 *   npm run escrever:frequencia -- --de 2026-08-24 --ate 2026-08-24
 *   npm run escrever:frequencia -- --de 2026-08-24 --ate 2026-08-24 --turma 1266
 *   npm run escrever:frequencia -- ... --executar
 *
 * ─── SEM `--executar`, NADA É ENVIADO ───────────────────────────────────────
 *
 * O default é ensaio. Não por timidez: este é o único script do projeto que
 * altera a base acadêmica de uma escola, e o `SaveRecord` é upsert que responde
 * HTTP 200 mesmo recusando. Um default que escreve transformaria erro de digitação
 * em incidente.
 *
 * ─── OS QUATRO GUARDAS, NESTA ORDEM ─────────────────────────────────────────
 *
 * A ordem não é estilo, é consequência. Cada um responde a uma pergunta
 * diferente, e a resposta da anterior é entrada da seguinte:
 *
 *   1. PROJEÇÃO      "o RM aceitaria esta linha?"      -> recusa vira relatório
 *   2. DECISÃO       "escrever apaga trabalho humano?" -> 6 vereditos, por linha
 *   3. PENDÊNCIA     "quem decide o que recusamos?"    -> fila com dono
 *   4. TETO+GATE     "este VOLUME faz sentido?"        -> olha o agregado
 *
 * Só o 4 enxerga o conjunto. Os três primeiros são por registro, e por isso não
 * conseguiriam pegar o defeito que mais assusta: um de-para corrompido em que
 * cada linha, isolada, parece perfeitamente razoável.
 *
 * ─── A JANELA DO `AULASDADAS` ───────────────────────────────────────────────
 *
 * Ler o RM e escrever no RM acontecem no MESMO run, o mais perto possível, porque
 * o `AULASDADAS` é ecoado. Se um professor mudar o número entre a leitura e o
 * `SaveRecord`, o eco reverte a alteração dele em silêncio. Não há mitigação hoje
 * — só estreitamento da janela. Está registrado como dívida em docs/DECISOES.md.
 */

const TETO_REGISTROS = 20_000;

interface Args {
  de: string;
  ate: string;
  turma?: string;
  executar: boolean;
  /** Nome de quem opera, gravado junto do pedido de aprovação. */
  quem?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const pega = (nome: string): string | undefined => {
    const i = argv.indexOf(`--${nome}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const de = pega('de');
  const ate = pega('ate');
  const dataOk = (v: string | undefined): boolean => Boolean(v && /^\d{4}-\d{2}-\d{2}$/.test(v));

  if (!dataOk(de) || !dataOk(ate)) {
    throw new Error(
      'Faltou a janela de datas. Uso: --de YYYY-MM-DD --ate YYYY-MM-DD ' +
        '[--turma IDTURMADISC] [--executar] [--quem SEU_NOME]',
    );
  }
  if ((de as string) > (ate as string)) {
    throw new Error(`Janela invertida: --de ${de} é depois de --ate ${ate}.`);
  }
  return {
    de: de as string,
    ate: ate as string,
    turma: pega('turma'),
    executar: argv.includes('--executar'),
    quem: pega('quem'),
  };
}

/** Um único campus: o contexto do wsDataServer exige UM CODFILIAL. */
function campusUnico(): string {
  const campi = cfg.rm.escopo.filiais.split(',').map((c) => c.trim()).filter(Boolean);
  if (cfg.rm.escopo.filiais.toUpperCase() === 'ALL' || campi.length !== 1) {
    throw new Error(
      `RM_CODFILIAL="${cfg.rm.escopo.filiais}" não serve para escrita: o contexto do ` +
        'wsDataServer exige UM CODFILIAL. Rode um campus por vez.',
    );
  }
  return campi[0];
}

const p = (s = ''): void => {
  // eslint-disable-next-line no-console
  console.log(s);
};

/** O que aconteceu com cada linha depois do envio. */
interface ResultadoEnvio {
  escritas: Projetado[];
  recusadas: Array<{ linha: Projetado; resposta: string }>;
  desconhecidas: Projetado[];
  /** Quantos SaveRecord foram gastos. Entra no relatório: é o custo do isolamento. */
  chamadas: number;
}

/**
 * Envia um conjunto de linhas e, se o RM recusar, ISOLA a(s) culpada(s).
 *
 * ─── POR QUE ISTO EXISTE ────────────────────────────────────────────────────
 *
 * O `SaveRecord` é tudo-ou-nada por dataset. Medido em 24/08/2026: das 25 linhas
 * de uma aula de Geografia, UMA aluna não tinha vínculo com a turma-disciplina no
 * RM, e o RM recusou as 25. Tratar isso como "o lote falhou" faria a frequência
 * de 24 alunos depender de um cadastro que não é nosso e que não conseguimos
 * inspecionar antes (não há Sentença de matrícula por turma-disciplina).
 *
 * ─── BISSECÇÃO, NÃO LINHA A LINHA ───────────────────────────────────────────
 *
 * Reenviar uma linha por vez resolveria, ao custo de N chamadas SOAP sempre que
 * qualquer coisa falhasse. Partir ao meio custa O(k·log n) para k linhas ruins —
 * e k é tipicamente 1. Numa passada de dia inteiro, com 186 turmas-disciplina, a
 * diferença é entre minutos e horas.
 *
 * ─── O QUE NÃO SE FAZ AQUI ──────────────────────────────────────────────────
 *
 * Timeout (`desconhecido`) NÃO é partido. A escrita pode ter acontecido; dividir
 * e reenviar depois de um SENT_UNKNOWN é como escrever duas vezes de olhos
 * fechados. Essas linhas voltam marcadas como desconhecidas e quem decide é a
 * releitura.
 */
async function enviarComIsolamento(
  linhas: Projetado[],
  aulasDadasDe: (td: string, etapa: string) => string | null,
  contexto: string,
): Promise<ResultadoEnvio> {
  const vazio: ResultadoEnvio = { escritas: [], recusadas: [], desconhecidas: [], chamadas: 0 };
  if (linhas.length === 0) return vazio;

  // `montaLotes` agrupa por (IDTURMADISC, CODETAPA); um subconjunto do MESMO
  // grupo devolve exatamente um lote, e por isso dá para reusar a função aqui.
  const [lote] = montaLotes(linhas, aulasDadasDe);
  if (!lote || lote.aulasDadas === null) return { ...vazio, recusadas: [] };

  const r = await wsDataServerClient.saveRecord('EduFrequenciaDiariaWSData', lote.xml, contexto);

  if (r.desconhecido) {
    return { escritas: [], recusadas: [], desconhecidas: linhas, chamadas: 1 };
  }
  if (r.ok) {
    return { escritas: linhas, recusadas: [], desconhecidas: [], chamadas: 1 };
  }
  if (linhas.length === 1) {
    return {
      escritas: [],
      recusadas: [{ linha: linhas[0], resposta: r.resposta }],
      desconhecidas: [],
      chamadas: 1,
    };
  }

  const meio = Math.floor(linhas.length / 2);
  const a = await enviarComIsolamento(linhas.slice(0, meio), aulasDadasDe, contexto);
  const b = await enviarComIsolamento(linhas.slice(meio), aulasDadasDe, contexto);
  return {
    escritas: [...a.escritas, ...b.escritas],
    recusadas: [...a.recusadas, ...b.recusadas],
    desconhecidas: [...a.desconhecidas, ...b.desconhecidas],
    chamadas: 1 + a.chamadas + b.chamadas,
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const codFilial = campusUnico();
  const versao = configVersion();
  const janela = { de: args.de, ate: args.ate };

  /*
   * DUAS chaves, porque são duas perguntas diferentes.
   *
   * A de APROVAÇÃO identifica a INTENÇÃO — "escrever esta janela, neste escopo".
   * Mesma janela e mesmo escopo = mesma chave: reexecutar reencontra a aprovação
   * já concedida em vez de empilhar pedidos.
   *
   * A do RUN identifica a EXECUÇÃO. `abrirRun` faz UPSERT pela chave; com a
   * chave da intenção, toda passada da mesma janela sobrescreve a MESMA linha, e
   * o que sobra é uma linha por janela com início da primeira passada, desfecho
   * da última e "duração" igual ao vão entre as duas. Foi assim que o gráfico de
   * Notas passou a dizer "maior terminado: 235 min" com runs de 20 a 29 segundos
   * na lista logo acima — o mesmo defeito, no fluxo vizinho (PR #30).
   */
  const chaveDeAprovacao = `freq:${cfg.slug}:${codFilial}:${args.de}:${args.ate}:${args.turma ?? 'todas'}`;
  /*
   * UM instante serve a duas coisas: o sufixo que torna a chave do run única e
   * o `created_at` da linha. `abrirRun` não é chamado aqui — acontece depois de
   * ler o Toddle e o RM, e no caminho de saída antecipada acontece no fim — de
   * modo que, sem passar este marco, a duração mediria o registro e não o
   * trabalho.
   */
  const inicio = new Date();
  const chaveRun = `${chaveDeAprovacao}:${inicio.toISOString().slice(11, 19).replace(/:/g, '')}`;

  logger.info(
    { ...configVersionDetalhe(), configVersion: versao, janela: `${args.de} → ${args.ate}`, codFilial, chaveRun, executar: args.executar },
    args.executar ? 'ESCRITA de frequência no RM' : 'Ensaio de escrita (nada será enviado)',
  );

  await toddleClient.assertTargetOrganization();

  // ─── de-para, só ATIVOS ───────────────────────────────────────────────────
  const cursos = await idMappingRepository.listByType('COURSE', 'active');
  const alunos = await idMappingRepository.listByType('STUDENT', 'active');

  const cursoParaTurmaDisc = new Map(cursos.map((m) => [m.toddleId, m.rmCode]));
  const alunoParaRa = new Map(alunos.map((m) => [m.toddleId, m.rmCode]));

  let turmasEmEscopo = cursos.map((m) => m.rmCode);
  let cursosFiltrados = cursos;
  if (args.turma) {
    if (!turmasEmEscopo.includes(args.turma)) {
      throw new Error(
        `--turma ${args.turma} não está entre as turmas-disciplina com mapeamento COURSE ativo.`,
      );
    }
    turmasEmEscopo = [args.turma];
    cursosFiltrados = cursos.filter((m) => m.rmCode === args.turma);
    cursoParaTurmaDisc.clear();
    for (const m of cursosFiltrados) cursoParaTurmaDisc.set(m.toddleId, m.rmCode);
  }

  // ─── alvos no RM e horas do Toddle ────────────────────────────────────────
  const alvos = await RmAttendanceTargets.carregar(turmasEmEscopo, codFilial);
  const anos = await toddleClient.listAcademicYears();
  const anosIds = anos.map((a) => String(a.id)).filter(Boolean);
  const bellSchedules = anosIds.length ? await toddleClient.listBellSchedules(anosIds) : [];
  const periodos = bellSchedules.length
    ? PeriodTimeIndex.deBellSchedules(bellSchedules)
    : PeriodTimeIndex.vazio();

  // ─── 1. PROJEÇÃO ──────────────────────────────────────────────────────────
  const registros = await toddleClient.listAttendance({
    startDate: args.de,
    endDate: args.ate,
    courseIds: cursosFiltrados.map((m) => m.toddleId),
    maxRecords: TETO_REGISTROS,
  });

  const ctx: ContextoProjecao = {
    codColigada: cfg.rm.escopo.coligada,
    cursoParaTurmaDisc,
    alunoParaRa,
    alvos,
    periodos,
  };
  const resumo = projetaLote(registros, ctx);

  // ─── 2. DECISÃO, por linha ────────────────────────────────────────────────
  const noRm = await fetchFrequenciaFromRm(janela);
  const faltasPorChave = indexaFaltasPorChave(noRm.faltas);
  const proveniencia = await carregarProveniencia(
    'FREQUENCIA',
    resumo.projetados.map((pr) => pr.chaveRm),
  );

  const decisoes = new Map<string, Decisao>();
  for (const pr of resumo.projetados) {
    const chave = chaveNaturalRm(pr.linha);
    const falta = faltasPorChave.get(chave);
    decisoes.set(
      pr.origemId,
      decidirEscrita(
        { chaveNatural: chave, valor: pr.linha.presenca },
        falta ? estadoNoRmDeFalta(falta) : null,
        proveniencia.get(chaveDoMapa(chave)) ?? null,
      ),
    );
  }
  const resumoDecisoes = resumirDecisoes([...decisoes.values()]);

  // Só o que a decisão liberou entra no XML. Este filtro é o que separa este
  // script do shadow: lá o XML era ilustrativo, aqui ele é o que vai ser enviado.
  const liberados: Projetado[] = resumo.projetados.filter((pr) => {
    const d = decisoes.get(pr.origemId);
    return d?.veredito === 'ESCREVER_NOVO' || d?.veredito === 'ATUALIZAR_NOSSO';
  });

  const lotes = montaLotes(liberados, (td, etapa) => alvos.aulasDadasDe(td, etapa));
  const semAulasDadas = lotes.filter((l) => l.aulasDadas === null);
  const escreviveis = lotes.filter((l) => l.aulasDadas !== null);

  // ─── 4. TETO DE VOLUME ────────────────────────────────────────────────────
  const jaEscritas = await contarProveniencia();
  const volume = avaliarVolume(
    {
      aEscrever: resumoDecisoes.aEscrever,
      emEscopo: resumo.projetados.length,
      historico: jaEscritas.FREQUENCIA ?? null,
    },
    {
      tetoAbsoluto: env.WRITE_TETO_ABSOLUTO,
      desvioMaxPct: env.WRITE_DESVIO_MAX_PCT,
      tetoEscopoPct: env.WRITE_TETO_ESCOPO_PCT,
      pisoSemAprovacao: env.WRITE_PISO_SEM_APROVACAO,
    },
  );

  // ─── relatório do plano ───────────────────────────────────────────────────
  p('');
  p('══════════════════════════════════════════════════════════════════');
  p(`  FREQUÊNCIA Toddle -> RM   ${args.executar ? '*** ESCRITA ***' : '(ensaio)'}`);
  p('══════════════════════════════════════════════════════════════════');
  p(`  janela         ${args.de} → ${args.ate}`);
  p(`  campus         CODFILIAL=${codFilial}   coligada=${cfg.rm.escopo.coligada}`);
  p(`  escopo         ${turmasEmEscopo.length} turma-disciplina, ${alunos.length} alunos`);
  p(`  configVersion  ${versao}`);
  p(`  run            ${chaveRun}`);
  p(`  aprovação      ${chaveDeAprovacao}`);
  p('');
  p('── plano ─────────────────────────────────────────────────────────');
  p(`  lidos do Toddle                 ${registros.length}`);
  p(`  projetáveis                     ${resumo.projetados.length}`);
  p(`  recusados na projeção           ${resumo.recusados.length}`);
  for (const [motivo, n] of Object.entries(resumo.porMotivo ?? {})) p(`      ${motivo.padEnd(28)} ${n}`);
  p('');
  for (const [veredito, n] of Object.entries(resumoDecisoes.porVeredito)) {
    p(`      ${veredito.padEnd(28)} ${n}`);
  }
  p(`  A ESCREVER                      ${resumoDecisoes.aEscrever}`);
  p(`  pendências (precisam de humano) ${resumoDecisoes.pendencias}`);
  p('');
  p(`  datasets escrevíveis            ${escreviveis.length}`);
  for (const l of escreviveis) {
    p(`      IDTURMADISC ${l.idTurmaDisc}  etapa ${l.codEtapa}  ${l.linhas.length} linha(s)  AULASDADAS=${l.aulasDadas}`);
  }
  if (semAulasDadas.length) {
    p('');
    p(`  RECUSADOS por AULASDADAS ausente no RM   ${semAulasDadas.length}`);
    for (const l of semAulasDadas) {
      p(`      IDTURMADISC ${l.idTurmaDisc}  etapa ${l.codEtapa}  ${l.linhas.length} linha(s)`);
    }
    p('      A etapa não tem número de aulas dadas no RM. Não há o que ecoar, e');
    p('      calcular mudaria o denominador dos 75%. Preencha no RM primeiro.');
  }
  p('');
  p(`  teto de volume                  ${volume.veredito}`);
  for (const m of volume.motivos) p(`      ${m}`);

  // ─── 3. PENDÊNCIAS ────────────────────────────────────────────────────────
  //
  // Registradas mesmo em ensaio: anotar no NOSSO banco que alguém precisa olhar
  // não muda dado de ninguém, e a fila só tem valor se encher antes da escrita.
  let pendenciasAbertas = 0;
  for (const pr of resumo.projetados) {
    const d = decisoes.get(pr.origemId);
    if (!d?.pendencia) continue;
    const chave = chaveNaturalRm(pr.linha);
    const abriu = await registrarPendencia({
      entidade: 'FREQUENCIA',
      chaveNatural: chave,
      veredito: d.veredito as VereditoPendente,
      porque: d.porque,
      valorDesejado: pr.linha.presenca,
      valorNoRm: faltasPorChave.get(chave)?.presenca ?? null,
      hashDesejado: hashValor(pr.linha.presenca),
      origemId: pr.origemId,
    });
    if (abriu) pendenciasAbertas += 1;
  }

  // ─── 3b. CÓDIGO DE CHAMADA SEM POLÍTICA -> fila, agrupado por CÓDIGO ──────
  //
  // Recusa de projeção normalmente é defeito de dado e morre no relatório. Esta
  // não: "o Toddle mandou 'Leave' e o RM não sabe o que é isso" é uma decisão de
  // escola pendente, e enquanto ninguém decide o aluno fica SEM frequência no RM,
  // em silêncio. Ver a migration 012 para o porquê de uma linha por código.
  const porOpcao = new Map<string, { rotulo: string; n: number; exemplo: string }>();
  for (const r of resumo.recusados) {
    if (r.motivo !== 'OPCAO_SEM_POLITICA' || !r.opcao) continue;
    const atual = porOpcao.get(r.opcao.abreviacao);
    if (atual) atual.n += 1;
    else porOpcao.set(r.opcao.abreviacao, { rotulo: r.opcao.rotulo, n: 1, exemplo: r.origemId });
  }
  for (const [abrev, info] of porOpcao) {
    const abriu = await registrarPendencia({
      entidade: 'FREQUENCIA',
      chaveNatural: `OPCAO:${abrev}`,
      veredito: 'OPCAO_SEM_POLITICA',
      porque:
        `O Toddle usa o código "${info.rotulo}" (${abrev}) e não há tradução para ` +
        'PRESENCA no RM, então estes lançamentos NÃO chegam ao RM. Resolver aqui é ' +
        'decidir a POLÍTICA (POLITICA_PRESENCA em attendanceProjection.ts), não ' +
        'lançar falta à mão.',
      valorDesejado: null,
      valorNoRm: null,
      // O hash é do CÓDIGO, não de um valor: reabrir só faz sentido se a escola
      // renomear a opção, e é isso que este hash detecta.
      hashDesejado: hashValor(`${abrev}|${info.rotulo}`),
      origemId: info.exemplo,
    });
    if (abriu) pendenciasAbertas += 1;
  }
  const fila = await resumoPendencias();
  p('');
  p(`  fila de pendências (aberta)     ${fila.abertas}   (${pendenciasAbertas} nesta passada)`);

  if (!args.executar) {
    p('');
    p('  ENSAIO. Nada foi enviado ao RM. Use --executar para escrever.');
    p('');
    await pgPool.end();
    return;
  }

  if (escreviveis.length === 0) {
    p('');
    p('  Nada a escrever. Encerrando sem tocar o RM.');
    p('');
    await pgPool.end();
    return;
  }

  // ─── GATE DE APROVAÇÃO ────────────────────────────────────────────────────
  //
  // RECUSADO não tem porta: nem aprovação humana libera, porque o veredito
  // significa "isto não parece com o trabalho de um dia", e o caminho certo é
  // investigar o escopo, não autorizar.
  if (volume.veredito === 'RECUSADO') {
    p('');
    p('  RECUSADO pelo teto de volume. Nada foi enviado.');
    p('  Isto não é para ser aprovado — é para ser investigado. Confira o de-para');
    p('  e a janela antes de rodar de novo.');
    p('');
    await pgPool.end();
    process.exitCode = 1;
    return;
  }

  if (volume.veredito === 'PRECISA_APROVACAO' && !(await estaAprovado(chaveDeAprovacao))) {
    await pedirAprovacao({
      // A chave da INTENÇÃO, não a da execução: é por ela que a passada
      // seguinte reencontra a decisão. Com a chave por execução, a aprovação
      // ficaria órfã e o gate pediria decisão de novo a cada rodada.
      chave: chaveDeAprovacao,
      tipo: 'frequencia_toddle_para_rm',
      payload: {
        janela,
        codFilial,
        turmas: turmasEmEscopo.length,
        aEscrever: resumoDecisoes.aEscrever,
        datasets: escreviveis.map((l) => ({
          idTurmaDisc: l.idTurmaDisc,
          codEtapa: l.codEtapa,
          linhas: l.linhas.length,
          aulasDadas: l.aulasDadas,
        })),
        motivosDoTeto: volume.motivos,
        configVersion: versao,
        propostoPor: args.quem ?? null,
      },
    });
    p('');
    p('  PARADO no gate de aprovação. Nada foi enviado ao RM.');
    p('  A proposta está registrada. Para liberar:');
    p('');
    p('      npm run aprovar                      # lista o que espera decisão');
    p('      npm run aprovar -- --sim <ID> --quem "Seu Nome" --motivo "..."');
    p('');
    p('  Depois rode este comando de novo: ele reencontra a aprovação e executa.');
    p('');
    await pgPool.end();
    return;
  }

  // ─── ESCRITA ──────────────────────────────────────────────────────────────
  const runId = await abrirRun({
    tipo: 'frequencia_toddle_para_rm',
    chave: chaveRun,
    inicio,
    configVersion: versao,
    payload: {
      janela,
      codFilial,
      turmas: turmasEmEscopo.length,
      datasets: escreviveis.length,
      aEscrever: resumoDecisoes.aEscrever,
      operadoPor: args.quem ?? null,
    },
    resultadoInicial: { emEscopo: resumo.projetados.length },
  });
  const contexto = `CODCOLIGADA=${cfg.rm.escopo.coligada};CODFILIAL=${codFilial};CODTIPOCURSO=1;CODSISTEMA=S`;

  p('');
  p('── escrevendo ────────────────────────────────────────────────────');

  let recusadas: Array<{ linha: Projetado; resposta: string }> = [];
  let desconhecidas: Projetado[] = [];
  const escritas: Projetado[] = [];
  let chamadas = 0;

  for (const lote of escreviveis) {
    const rotulo = `IDTURMADISC ${lote.idTurmaDisc} etapa ${lote.codEtapa}`;
    const r = await enviarComIsolamento(
      lote.linhas,
      (td, etapa) => alvos.aulasDadasDe(td, etapa),
      contexto,
    );
    chamadas += r.chamadas;
    escritas.push(...r.escritas);
    recusadas = [...recusadas, ...r.recusadas];
    desconhecidas = [...desconhecidas, ...r.desconhecidas];

    const extra = r.chamadas > 1 ? `  (${r.chamadas} envios — houve isolamento)` : '';
    p(`  ${rotulo}: ${r.escritas.length} escrita(s), ${r.recusadas.length} recusada(s), ${r.desconhecidas.length} sem resposta${extra}`);

    // Proveniência SÓ do que o RM aceitou, e nunca antes do aceite: registrar
    // escrita que não aconteceu faria a próxima passada tratar linha de professor
    // como nossa.
    for (const item of r.escritas) {
      await registrarEscrita({
        entidade: 'FREQUENCIA',
        chaveNatural: item.chaveRm,
        payloadHash: hashValor(item.linha.presenca),
        runId,
      });
    }
  }

  // ─── A LINHA QUE O RM RECUSOU VIRA PENDÊNCIA ──────────────────────────────
  //
  // Sem isto, a recusa viveria só no stdout de um run — e o aluno ficaria sem
  // frequência no RM para sempre, em silêncio, que é o defeito que esta fila
  // inteira existe para impedir. Ver a migration 013.
  for (const { linha, resposta } of recusadas) {
    const limpa = resposta.replace(/&#xD;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
    const abriu = await registrarPendencia({
      entidade: 'FREQUENCIA',
      chaveNatural: linha.chaveRm,
      veredito: 'RM_RECUSOU',
      porque:
        `O RM recusou ESTA linha (as demais do mesmo lote foram escritas). ` +
        `Resposta do RM: "${limpa}". A causa mais comum medida é o aluno não ter ` +
        `vínculo com a turma-disciplina no RM — estar na turma não basta. ` +
        `Confira a matrícula do RA ${linha.linha.ra} na IDTURMADISC ${linha.linha.idTurmaDisc}.`,
      valorDesejado: linha.linha.presenca,
      valorNoRm: null,
      hashDesejado: hashValor(linha.linha.presenca),
      origemId: linha.origemId,
      runId,
    });
    if (abriu) pendenciasAbertas += 1;
  }

  // ─── CONFERÊNCIA POR LEITURA ──────────────────────────────────────────────
  //
  // O `SaveRecord` devolve HTTP 200 mesmo em erro de negócio, então a resposta
  // dele NUNCA é prova de que gravou. A prova é reler o RM.
  //
  // ─── O QUE É, E O QUE NÃO É, VERIFICÁVEL ─────────────────────────────────
  //
  // A `SFREQUENCIA` guarda AUSÊNCIA. Uma linha `PRESENCA='P'` não cria registro —
  // ela remove, se houver. Então "não achei a linha no RM" significa duas coisas
  // indistinguíveis para um 'P': deu certo, ou nunca saiu daqui.
  //
  // A primeira versão deste bloco contava os 'P' como confirmados, e imprimiu
  // "23/25 conferidas" num run em que o RM recusou TUDO e nada foi escrito. Era
  // um número tranquilizador e falso. Agora as duas populações são contadas
  // separadas, e só a das ausências é chamada de conferida.
  p('');
  p('── conferindo por leitura ────────────────────────────────────────');
  const depois = await fetchFrequenciaFromRm(janela);
  const agora = indexaFaltasPorChave(depois.faltas);

  const ausenciasEsperadas = escritas.filter((i) => i.linha.presenca !== 'P');
  const ausenciasConfirmadas = ausenciasEsperadas.filter((i) => agora.has(i.chaveRm));
  const presencasEnviadas = escritas.length - ausenciasEsperadas.length;

  p(`  faltas na janela        ${noRm.faltas.length} → ${depois.faltas.length}`);
  p(`  linhas escritas         ${escritas.length}   recusadas ${recusadas.length}   sem resposta ${desconhecidas.length}`);
  p(`  envios ao RM            ${chamadas}`);
  p(`  ausências CONFERIDAS    ${ausenciasConfirmadas.length}/${ausenciasEsperadas.length}   (releitura achou a linha no RM)`);
  p(`  presenças enviadas      ${presencasEnviadas}   (não verificáveis: 'P' não cria linha na SFREQUENCIA)`);

  if (recusadas.length) {
    p('');
    p(`  ${recusadas.length} linha(s) o RM recusou individualmente — viraram pendência:`);
    for (const { linha } of recusadas.slice(0, 10)) {
      p(`      RA ${linha.linha.ra}  IDTURMADISC ${linha.linha.idTurmaDisc}  ${linha.linha.data}`);
    }
    p('      `npm run pendencias` mostra a resposta do RM em cada uma.');
  }

  const ok =
    desconhecidas.length === 0 &&
    ausenciasConfirmadas.length === ausenciasEsperadas.length;

  await fecharRun(runId, ok ? 'succeeded' : 'failed', {
    escritas: escritas.length,
    recusadas: recusadas.length,
    desconhecidas: desconhecidas.length,
    chamadas,
    ausenciasEsperadas: ausenciasEsperadas.length,
    ausenciasConfirmadas: ausenciasConfirmadas.length,
    presencasEnviadas,
  });

  p('');
  if (ok && recusadas.length === 0) {
    p('  OK — a frequência lançada no Toddle está no RM, e a proveniência registrou');
    p('  cada linha. `npm run runs` mostra o run; a lista de reversão sai dele.');
  } else if (ok) {
    p('  PARCIAL — o que o RM aceitou está escrito e com proveniência. O que ele');
    p('  recusou está na fila de pendências, com a resposta dele. Nada foi perdido');
    p('  em silêncio, e nada será repetido automaticamente.');
  } else {
    p('  ATENÇÃO — o run não fechou limpo. Há linha sem resposta ou ausência que a');
    p('  releitura não encontrou. Nada será repetido automaticamente.');
  }
  p('');
  await pgPool.end();
}

main().catch(async (err) => {
  logger.error({ err }, 'Falha na escrita de frequência');
  await pgPool.end().catch(() => undefined);
  process.exit(1);
});
