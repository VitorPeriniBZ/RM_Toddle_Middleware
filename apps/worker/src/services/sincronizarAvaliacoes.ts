import { configVersion, env, logger, tenantConfig } from '@rm-toddle/config';
import {
  abrirRun,
  carregarProveniencia,
  chaveDoMapa,
  contarProveniencia,
  estaAprovado,
  fecharRun,
  idMappingRepository,
  pedirAprovacao,
  registrarEscrita,
  registrarPendencia,
  resumoPendencias,
  type VereditoPendente,
} from '@rm-toddle/db';
import { toddleClient, wsDataServerClient } from '@rm-toddle/integrations';
import {
  achataAvaliacoes,
  ambiguidadesDeEtapa,
  avaliarVolume,
  canonizarNota,
  decidirEscrita,
  hashValor,
  montaLotesNotasAvaliacao,
  montaXmlProva,
  projetaLoteAvaliacoes,
  resumirDecisoes,
  RmAssessmentTargets,
  RmGradeTargets,
  type AvaliacaoVolume,
  type ContextoProjecaoAvaliacao,
  type Decisao,
  type JanelaToddle,
  type LoteNotasAvaliacao,
  type NotaParaEscrever,
  type ProvaParaCriar,
} from '@rm-toddle/domain';

const cfg = tenantConfig;

/**
 * A via de NOTA DE AVALIAÇÃO: Toddle -> TOTVS RM.
 *
 * ─── POR QUE ESTA ORQUESTRAÇÃO SAIU DO SCRIPT ───────────────────────────────
 *
 * Ela morava dentro de `scripts/escreverAvaliacoes.ts`, e o comentário de lá
 * dizia: "sem serviço extraído: não existe segundo consumidor". Agora existe. O
 * job `term-grades.sync` apontava para a nota de ETAPA, destino que o
 * `EduNotaEtapaData` aceita e DESCARTA (`ok=true`, releitura `0.0000`, medido em
 * 09/09/2026) — ele não podia rodar, e por isso o fluxo estava bloqueado na tela.
 *
 * Redirecioná-lo exigia que os dois caminhos — o CLI e o job — chamassem o MESMO
 * código. Duplicar a orquestração faria os dois divergirem, e o lado que
 * divergisse em silêncio seria o automático, que ninguém lê.
 *
 * ─── DOIS DESTINOS, E UM DELES É ESTRUTURA ──────────────────────────────────
 *
 * `SProvas` é a avaliação; `SNotas` é a nota dela. Quando o assignment do Toddle
 * não tem prova no RM, este serviço CRIA a prova — e isso é escrever ESTRUTURA
 * acadêmica, não valor. Nota errada se corrige; avaliação a mais polui a tela do
 * professor e o boletim. Por isso as provas a criar saem separadas no relatório
 * e contam para o gate de volume.
 *
 * ─── O QUE ELE NÃO FAZ ──────────────────────────────────────────────────────
 *
 * Não fecha a etapa. Escrever `SNotas` NÃO recalcula `SNOTAETAPA` — medido,
 * inclusive tocando o `SNotaEtapa` depois e esperando. Fechar o boletim é
 * processo do RM e ato humano.
 */

/**
 * Relata progresso. Chamado só onde há denominador de verdade — ver
 * `packages/queues/src/progresso.ts`. A leitura do Toddle e do RM não tem:
 * ali só se sabe dizer a fase.
 */
export type AoProgredir = (p: { fase: string; feitos?: number; total?: number }) => void;

export interface OpcoesSincronizacaoAvaliacoes {
  /** `false` = ensaio: tudo é calculado, nada é enviado ao RM. */
  executar: boolean;
  /** Restringe a UMA turma-disciplina (IDTURMADISC). */
  turma?: string;
  /** Data de referência do teste de janela. Default: hoje. */
  dataRef?: string;
  /** Ver `NOTA_EXIGIR_ETAPA_LIBERADA`. Default: o valor do ambiente. */
  exigirEtapaLiberada?: boolean;
  /** Quem operou, gravado no pedido de aprovação. */
  quem?: string;
  /** Opcional: o job usa para publicar `job.updateProgress`. O CLI ignora. */
  aoProgredir?: AoProgredir;
}

export interface RelatorioAvaliacoes {
  chaveRun: string;
  codFilial: string;
  configVersion: string;
  dataRef: string;
  tiposElegiveis: string[];
  turmasEmEscopo: number;
  origem: {
    avaliacoes: number;
    porTipo: Record<string, number>;
    resultadosLidos: number;
    comNota: number;
    semNota: number;
    soRubrica: number;
  };
  alvos: { etapasDigitaveis: number; provas: number; notas: number };
  projecao: {
    projetaveis: number;
    recusados: number;
    porMotivo: Record<string, number>;
    /**
     * Um exemplo de recusa POR MOTIVO, com o texto inteiro.
     *
     * O relatório mostrava só a contagem, e a contagem não endereça ninguém:
     * "JANELA_INCOMPATIVEL 558" não diz qual data mexer nem em qual sistema. O
     * texto da recusa diz — e antes disto ele existia e ninguém o lia.
     *
     * Um por motivo, não todos: 558 linhas iguais afogariam o relatório, e a
     * 559ª não acrescenta nada à 1ª.
     */
    exemploPorMotivo: Record<string, string>;
    colisoes: number;
  };
  decisoes: { porVeredito: Record<string, number>; aEscrever: number; pendencias: number };
  provasACriar: ProvaParaCriar[];
  lotes: LoteNotasAvaliacao[];
  volume: AvaliacaoVolume;
  pendenciasAbertasNestaPassada: number;
  filaAberta: number;
  /** Preenchido só quando `executar` e o gate liberou. */
  escrita?: {
    provasCriadas: number;
    provasQueFalharam: Array<{ chave: string; resposta: string }>;
    notasEnviadas: number;
    conferidas: number;
    divergentes: Array<{ chave: string; enviado: string; noRm: string }>;
    recusadas: Array<{ chave: string; resposta: string }>;
    chamadas: number;
    provasNoRm: { antes: number; depois: number };
    notasNoRm: { antes: number; depois: number };
  };
  /** Por que não escreveu, quando não escreveu. */
  naoEscreveu?:
    | 'ensaio'
    | 'nada-a-escrever'
    | 'recusado-pelo-teto'
    | 'precisa-aprovacao'
    | 'desligado';
}

/** Um único campus: o contexto do wsDataServer exige UM CODFILIAL. */
export function campusUnico(): string {
  const campi = cfg.rm.escopo.filiais.split(',').map((c) => c.trim()).filter(Boolean);
  if (cfg.rm.escopo.filiais.toUpperCase() === 'ALL' || campi.length !== 1) {
    throw new Error(
      `RM_CODFILIAL="${cfg.rm.escopo.filiais}" não serve para escrita: o contexto do ` +
        'wsDataServer exige UM CODFILIAL. Rode um campus por vez.',
    );
  }
  return campi[0];
}

export async function sincronizarAvaliacoes(
  op: OpcoesSincronizacaoAvaliacoes,
): Promise<RelatorioAvaliacoes> {
  const codFilial = campusUnico();
  const versao = configVersion();
  const dataRef = op.dataRef ?? new Date().toISOString().slice(0, 10);
  const chaveRun = `aval:${cfg.slug}:${codFilial}:${op.turma ?? 'todas'}:${dataRef}`;

  const progresso: AoProgredir = op.aoProgredir ?? (() => undefined);
  progresso({ fase: 'conferindo a organização do Toddle' });
  await toddleClient.assertTargetOrganization();

  // ─── de-para, só ATIVOS ───────────────────────────────────────────────────
  const cursos = await idMappingRepository.listByType('COURSE', 'active');
  const alunos = await idMappingRepository.listByType('STUDENT', 'active');
  const etapasMap = await idMappingRepository.listByType('GRADING_PERIOD', 'active');
  const avaliacoesMap = await idMappingRepository.listByType('ASSESSMENT', 'active');

  const cursoParaTurmaDisc = new Map(cursos.map((m) => [m.toddleId, m.rmCode]));
  const alunoParaRa = new Map(alunos.map((m) => [m.toddleId, m.rmCode]));
  const periodoParaEtapa = new Map(etapasMap.map((m) => [m.toddleId, m.rmCode]));
  const avaliacaoMapeada = new Map(avaliacoesMap.map((m) => [m.toddleId, m.rmCode]));

  let turmasEmEscopo = cursos.map((m) => m.rmCode);
  let cursosFiltrados = cursos;
  if (op.turma) {
    if (!turmasEmEscopo.includes(op.turma)) {
      throw new Error(`--turma ${op.turma} não tem de-para COURSE ativo.`);
    }
    turmasEmEscopo = [op.turma];
    cursosFiltrados = cursos.filter((m) => m.rmCode === op.turma);
    cursoParaTurmaDisc.clear();
    for (const m of cursosFiltrados) cursoParaTurmaDisc.set(m.toddleId, m.rmCode);
  }

  // ─── alvos no RM ──────────────────────────────────────────────────────────
  progresso({ fase: 'lendo etapas e avaliações do RM' });
  const etapas = await RmGradeTargets.carregar(turmasEmEscopo, codFilial);
  const alvos = await RmAssessmentTargets.carregar(turmasEmEscopo, codFilial);

  // ─── currículo, ano e janelas ─────────────────────────────────────────────
  const nossos = new Set(cursosFiltrados.map((c) => c.toddleId));
  const classes = (await toddleClient.listClasses()).filter((c) => nossos.has(String(c.id)));
  const curriculos = [...new Set(classes.map((c) => String(c.curriculumId ?? '')).filter(Boolean))];
  if (curriculos.length === 0) throw new Error('Nenhuma turma mapeada tem curriculumId no Toddle.');

  const anos = await toddleClient.listAcademicYears();
  const academicYearId = String(anos.find((a) => a.isCurrent === true)?.id ?? '');

  const janelaDoPeriodo = new Map<string, JanelaToddle>();
  for (const c of curriculos) {
    for (const gp of await toddleClient.listGradingPeriods(c)) {
      if (gp.startDate && gp.endDate) {
        janelaDoPeriodo.set(String(gp.id), {
          inicio: String(gp.startDate).slice(0, 10),
          fim: String(gp.endDate).slice(0, 10),
        });
      }
    }
  }

  // ─── 1. PROJEÇÃO ──────────────────────────────────────────────────────────
  //
  // O filtro por `classIds` é o que mantém isto barato: sem ele a leitura traz
  // os 223 assignments do sandbox, 222 deles de turmas de demonstração.
  progresso({ fase: 'lendo avaliações do Toddle' });
  const idsDasNossas = classes.map((c) => String(c.id));

  // ─── TODOS OS CURRÍCULOS, NÃO O PRIMEIRO ─────────────────────────────────
  //
  // Isto lia `curriculos[0]`. Com um currículo só — o caso de hoje — dá no
  // mesmo; com dois, as avaliações do segundo simplesmente não eram lidas, sem
  // erro e sem contador. A nota do professor sumia entre a tela dele e o RM, e o
  // relatório diria "nada a escrever" com toda a confiança.
  //
  // O laço das janelas logo acima já percorria todos; só estas duas leituras
  // ficaram para trás.
  const assignments: Awaited<ReturnType<typeof toddleClient.listAssignments>> = [];
  const resultados: Awaited<ReturnType<typeof toddleClient.listStudentAssignments>> = [];

  for (const curriculo of curriculos) {
    const doCurriculo = await toddleClient.listAssignments({
      curriculumProgramId: curriculo,
      academicYearId: academicYearId || undefined,
      classIds: idsDasNossas,
      maxRecords: 5_000,
    });
    if (doCurriculo.length === 0) continue;
    assignments.push(...doCurriculo);
    resultados.push(
      ...(await toddleClient.listStudentAssignments({
        curriculumProgramId: curriculo,
        assignmentIds: doCurriculo.map((a) => String(a.id)),
        maxRecords: 20_000,
      })),
    );
  }

  logger.info(
    { curriculos: curriculos.length, assignments: assignments.length, resultados: resultados.length },
    'Avaliações lidas do Toddle (todos os currículos em escopo)',
  );

  const origem = achataAvaliacoes(assignments, resultados);

  const tiposElegiveis = env.NOTA_TIPOS_ELEGIVEIS.split(',').map((t) => t.trim()).filter(Boolean);
  const ctx: ContextoProjecaoAvaliacao = {
    codColigada: String(cfg.rm.escopo.coligada),
    alunoParaRa,
    cursoParaTurmaDisc,
    periodoParaEtapa,
    janelaDoPeriodo,
    etapasRm: etapas.etapas,
    alvos,
    avaliacaoMapeada,
    tiposElegiveis,
    dataReferencia: dataRef,
    exigirEtapaLiberada: op.exigirEtapaLiberada ?? env.NOTA_EXIGIR_ETAPA_LIBERADA,
  };
  // ─── AMBIGUIDADE DE ETAPA: ACUSAR, NUNCA ESCOLHER ────────────────────────
  //
  // `janelaCompativel` recusa quando as janelas não se cruzam. A presença de
  // cruzamento, porém, não prova que a etapa é a certa: medido em 12/09/2026, o
  // T2 do Toddle cruza a etapa 2 do RM E a etapa 3, esta por 14 dias. Se o
  // de-para apontasse para a errada, nada reclamaria e a nota do 2º trimestre
  // entraria no 3º. O de-para está certo hoje — e nada o verifica.
  const ambiguas = ambiguidadesDeEtapa(janelaDoPeriodo, [...etapas.etapas.values()], periodoParaEtapa);
  for (const a of ambiguas) {
    logger.warn(
      {
        gradingPeriodId: a.gradingPeriodId,
        janelaToddle: `${a.janela.inicio}→${a.janela.fim}`,
        mapeadaPara: `CODETAPA ${a.mapeadaPara}`,
        candidatas: a.candidatas.map((c) => `CODETAPA ${c.codEtapa} (${c.diasDeSobreposicao}d)`),
      },
      'ETAPA AMBÍGUA: este período do Toddle se sobrepõe a mais de uma etapa do RM. O de-para ' +
        'decide qual vale, e nada o verifica — se ele apontar para a errada, a nota entra no ' +
        'trimestre errado sem erro nenhum. Alinhar os calendários elimina a ambiguidade.',
    );
  }

  const proj = projetaLoteAvaliacoes(origem.avaliacoes, origem.notas, ctx);

  // ─── 2. DECISÃO, por linha ────────────────────────────────────────────────
  //
  // Sem autoria: o ReadView de EduNotasData não expõe RECCREATEDBY. Então a
  // única evidência de que uma nota é nossa é a proveniência local, e nota que
  // exista no RM sem ela vira CONFLITO_HUMANO. É o lado certo para errar.
  const proveniencia = await carregarProveniencia('NOTA', proj.projetados.map((x) => x.chaveRm));
  const decisoes = new Map<string, Decisao>();
  for (const x of proj.projetados) {
    const noRm = alvos.notasPorChave.get(x.chaveRm);
    decisoes.set(
      x.origemId,
      decidirEscrita(
        { chaveNatural: x.chaveRm, valor: canonizarNota(x.linha.nota) },
        noRm ? { valor: noRm.nota } : null,
        proveniencia.get(chaveDoMapa(x.chaveRm)) ?? null,
      ),
    );
  }
  const resumoDecisoes = resumirDecisoes([...decisoes.values()]);

  const liberados = proj.projetados.filter((x) => {
    const d = decisoes.get(x.origemId);
    return d?.veredito === 'ESCREVER_NOVO' || d?.veredito === 'ATUALIZAR_NOSSO';
  });
  const lotes = montaLotesNotasAvaliacao(liberados.map((x) => x.linha));

  // Só as provas de que alguma nota liberada precisa.
  const provasNecessarias = proj.provasACriar.filter((pr) =>
    liberados.some((x) => x.linha.idTurmaDisc === pr.idTurmaDisc && x.linha.codProva === pr.codProva),
  );

  // ─── 3. PENDÊNCIAS ────────────────────────────────────────────────────────
  let pendenciasAbertas = 0;
  for (const x of proj.projetados) {
    const d = decisoes.get(x.origemId);
    if (!d?.pendencia) continue;
    const abriu = await registrarPendencia({
      entidade: 'NOTA',
      chaveNatural: x.chaveRm,
      veredito: d.veredito as VereditoPendente,
      porque:
        `${d.porque}. Nota de AVALIAÇÃO (CODPROVA ${x.linha.codProva}); o ReadView do RM não ` +
        'expõe autoria, então "existe e não é nossa" é o veredito conservador.',
      valorDesejado: canonizarNota(x.linha.nota),
      valorNoRm: alvos.notasPorChave.get(x.chaveRm)?.nota ?? null,
      hashDesejado: hashValor(canonizarNota(x.linha.nota)),
      origemId: x.origemId,
    });
    if (abriu) pendenciasAbertas += 1;
  }
  const fila = await resumoPendencias();

  // ─── 4. TETO DE VOLUME ────────────────────────────────────────────────────
  const jaEscritas = await contarProveniencia();
  const volume = avaliarVolume(
    {
      aEscrever: resumoDecisoes.aEscrever,
      emEscopo: proj.projetados.length,
      historico: jaEscritas.NOTA ?? null,
    },
    {
      tetoAbsoluto: env.WRITE_TETO_ABSOLUTO,
      desvioMaxPct: env.WRITE_DESVIO_MAX_PCT,
      tetoEscopoPct: env.WRITE_TETO_ESCOPO_PCT,
      pisoSemAprovacao: env.WRITE_PISO_SEM_APROVACAO,
    },
  );

  const base: RelatorioAvaliacoes = {
    chaveRun,
    codFilial,
    configVersion: versao,
    dataRef,
    tiposElegiveis,
    turmasEmEscopo: turmasEmEscopo.length,
    origem: {
      avaliacoes: origem.avaliacoes.length,
      porTipo: origem.porTipo,
      resultadosLidos: origem.resultadosLidos,
      comNota: origem.notas.length,
      semNota: origem.semNota,
      soRubrica: origem.soRubrica,
    },
    alvos: {
      etapasDigitaveis: etapas.totalEtapas,
      provas: alvos.totalProvas,
      notas: alvos.totalNotas,
    },
    projecao: {
      projetaveis: proj.projetados.length,
      recusados: proj.recusados.length,
      porMotivo: proj.porMotivo,
      exemploPorMotivo: primeiroPorMotivo(proj.recusados),
      colisoes: proj.colisoes.length,
    },
    decisoes: {
      porVeredito: resumoDecisoes.porVeredito,
      aEscrever: resumoDecisoes.aEscrever,
      pendencias: resumoDecisoes.pendencias,
    },
    provasACriar: provasNecessarias,
    lotes,
    volume,
    pendenciasAbertasNestaPassada: pendenciasAbertas,
    filaAberta: fila.abertas,
  };

  // ─── PASSADA SEM ESCRITA TAMBÉM DEIXA PROVA ───────────────────────────────
  //
  // `abrirRun` só era chamado quando a via ia escrever de fato. Consequência:
  // o job rodava no cron, terminava corretamente sem ter o que fazer, e NÃO
  // gravava linha nenhuma em `job_run` — então a tela dizia "último sucesso:
  // NUNCA" indefinidamente, e o alerta por ausência de sucesso ia disparar como
  // se o fluxo estivesse morto.
  //
  // "Rodou e não havia o que escrever" é um desfecho legítimo e frequente (é o
  // desfecho NORMAL fora das janelas de lançamento). Ele precisa aparecer, com
  // o motivo, senão é indistinguível de "não rodou" — que é a confusão exata
  // que este projeto já pagou caro para não repetir.
  //
  // O estado NÃO é sempre `succeeded`: teto recusado e aprovação pendente pedem
  // gente, e pintá-los de verde os esconderia.
  async function registrarPassada(
    naoEscreveu: NonNullable<RelatorioAvaliacoes['naoEscreveu']>,
    estado: 'succeeded' | 'failed',
  ): Promise<RelatorioAvaliacoes> {
    const runId = await abrirRun({
      tipo: 'avaliacao_toddle_para_rm',
      chave: chaveRun,
      configVersion: versao,
      payload: { codFilial, dataRef, operadoPor: op.quem ?? null, semEscrita: true },
    });
    await fecharRun(runId, estado, {
      naoEscreveu,
      projetaveis: proj.projetados.length,
      recusados: proj.recusados.length,
      porMotivo: proj.porMotivo,
      // O texto do motivo, não só a contagem: é ele que diz o que fazer.
      exemploPorMotivo: primeiroPorMotivo(proj.recusados),
      aEscrever: resumoDecisoes.aEscrever,
      pendencias: resumoDecisoes.pendencias,
    });
    return { ...base, naoEscreveu };
  }

  // ─── os portões, antes de qualquer envio ──────────────────────────────────
  //
  // O ensaio NÃO registra run: é um humano olhando, não uma passada agendada, e
  // gravá-lo faria o histórico mentir sobre quando o fluxo rodou sozinho.
  if (!op.executar) return { ...base, naoEscreveu: 'ensaio' };
  if (lotes.length === 0) return registrarPassada('nada-a-escrever', 'succeeded');
  if (volume.veredito === 'RECUSADO') return registrarPassada('recusado-pelo-teto', 'failed');
  if (volume.veredito === 'PRECISA_APROVACAO' && !(await estaAprovado(chaveRun))) {
    await pedirAprovacao({
      chave: chaveRun,
      tipo: 'avaliacao_toddle_para_rm',
      payload: {
        codFilial,
        dataRef,
        aEscrever: resumoDecisoes.aEscrever,
        provasACriar: provasNecessarias.map((pr) => ({
          idTurmaDisc: pr.idTurmaDisc,
          codEtapa: pr.codEtapa,
          codProva: pr.codProva,
          descricao: pr.descricao,
          valor: pr.valor,
        })),
        datasets: lotes.map((l) => ({
          idTurmaDisc: l.idTurmaDisc,
          codProva: l.codProva,
          linhas: l.linhas.length,
        })),
        motivosDoTeto: volume.motivos,
        configVersion: versao,
        propostoPor: op.quem ?? null,
      },
    });
    return registrarPassada('precisa-aprovacao', 'failed');
  }

  // ─── ESCRITA ──────────────────────────────────────────────────────────────
  const runId = await abrirRun({
    tipo: 'avaliacao_toddle_para_rm',
    chave: chaveRun,
    configVersion: versao,
    payload: {
      codFilial,
      dataRef,
      provas: provasNecessarias.length,
      notas: resumoDecisoes.aEscrever,
      operadoPor: op.quem ?? null,
    },
  });
  const contexto =
    `CODCOLIGADA=${cfg.rm.escopo.coligada};CODFILIAL=${codFilial};` +
    `CODTIPOCURSO=1;CODSISTEMA=${cfg.rm.conexao.sistema}`;

  // Fase A: as avaliações. Sem elas a nota não tem endereço, então uma falha
  // aqui pula o grupo em vez de escrever nota órfã.
  const provasOk = new Set<string>();
  const provasQueFalharam: Array<{ chave: string; resposta: string }> = [];
  let feitasA = 0;
  for (const pr of provasNecessarias) {
    progresso({ fase: 'criando avaliações no RM', feitos: feitasA, total: provasNecessarias.length });
    feitasA += 1;
    const chave = `${pr.idTurmaDisc}|${pr.codEtapa}|${pr.codProva}`;
    const r = await wsDataServerClient.saveRecord('EduProvasData', montaXmlProva(pr), contexto);
    if (r.ok) {
      provasOk.add(chave);
      await idMappingRepository.upsert({
        entityType: 'ASSESSMENT',
        rmCode: pr.rmCode,
        toddleId: pr.assignmentId,
      });
    } else {
      provasQueFalharam.push({ chave, resposta: r.resposta.replace(/\s+/g, ' ').slice(0, 300) });
    }
  }

  // Fase B: as notas.
  const escritas: NotaParaEscrever[] = [];
  const recusadas: Array<{ chave: string; resposta: string }> = [];
  let chamadas = 0;

  let feitosB = 0;
  for (const l of lotes) {
    progresso({ fase: 'escrevendo notas no RM', feitos: feitosB, total: lotes.length });
    feitosB += 1;
    const chaveProva = `${l.idTurmaDisc}|${l.codEtapa}|${l.codProva}`;
    const precisava = provasNecessarias.some(
      (pr) => `${pr.idTurmaDisc}|${pr.codEtapa}|${pr.codProva}` === chaveProva,
    );
    if (precisava && !provasOk.has(chaveProva)) {
      recusadas.push({ chave: chaveProva, resposta: 'a avaliação não pôde ser criada — lote pulado' });
      continue;
    }
    const r = await wsDataServerClient.saveRecord('EduNotasData', l.xml, contexto);
    chamadas += 1;
    if (r.ok) escritas.push(...l.linhas);
    else recusadas.push({ chave: chaveProva, resposta: r.resposta.replace(/\s+/g, ' ').slice(0, 300) });
  }

  for (const x of liberados) {
    if (!escritas.some((e) => e.ra === x.linha.ra && e.codProva === x.linha.codProva)) continue;
    await registrarEscrita({
      entidade: 'NOTA',
      chaveNatural: x.chaveRm,
      // Canônico, e igual ao que `decidirEscrita` vai comparar na próxima
      // passada. Gravar aqui a forma crua era o que fazia toda nota nossa
      // reaparecer como "editada por fora". Ver `notaCanonica`.
      payloadHash: hashValor(canonizarNota(x.linha.nota)),
      runId,
    });
  }

  // ─── CONFERÊNCIA POR LEITURA ──────────────────────────────────────────────
  //
  // O SaveRecord responde HTTP 200 mesmo recusando, e o EduNotaEtapaData provou
  // que ele também aceita e DESCARTA. Aqui a releitura confere chave E valor —
  // é esta conferência, e não o `ok`, que autoriza dizer que a nota chegou.
  progresso({ fase: 'conferindo por releitura' });
  const depois = await RmAssessmentTargets.carregar(turmasEmEscopo, codFilial);
  let conferidas = 0;
  const divergentes: Array<{ chave: string; enviado: string; noRm: string }> = [];
  for (const x of liberados) {
    const n = depois.notasPorChave.get(x.chaveRm);
    if (n && Number(n.nota) === Number(x.linha.nota)) conferidas += 1;
    else if (escritas.some((e) => e.ra === x.linha.ra && e.codProva === x.linha.codProva)) {
      divergentes.push({
        chave: x.chaveRm,
        enviado: String(x.linha.nota),
        noRm: n?.nota ?? '(ausente)',
      });
    }
  }

  const ok = divergentes.length === 0 && recusadas.length === 0 && provasQueFalharam.length === 0;
  await fecharRun(runId, ok ? 'succeeded' : 'failed', {
    provasCriadas: provasOk.size,
    notasEscritas: escritas.length,
    conferidas,
    divergentes: divergentes.length,
    recusadas: recusadas.length,
    chamadas,
    pendenciasAbertas,
  });

  logger.info(
    {
      chaveRun,
      provasCriadas: provasOk.size,
      notasEnviadas: escritas.length,
      conferidas,
      divergentes: divergentes.length,
      recusadas: recusadas.length,
    },
    ok ? 'Nota de avaliação escrita e conferida' : 'Escrita de nota de avaliação com divergência',
  );

  return {
    ...base,
    escrita: {
      provasCriadas: provasOk.size,
      provasQueFalharam,
      notasEnviadas: escritas.length,
      conferidas,
      divergentes,
      recusadas,
      chamadas,
      provasNoRm: { antes: alvos.totalProvas, depois: depois.totalProvas },
      notasNoRm: { antes: alvos.totalNotas, depois: depois.totalNotas },
    },
  };
}

/** O primeiro `detalhe` de cada motivo. Ver `exemploPorMotivo`. */
function primeiroPorMotivo(recusados: readonly { motivo: string; detalhe: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of recusados) if (!out[r.motivo]) out[r.motivo] = r.detalhe;
  return out;
}
