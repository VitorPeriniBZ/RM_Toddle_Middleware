import { env, logger, tenantConfig } from '@rm-toddle/config';
import { idMappingRepository } from '@rm-toddle/db';
import { toddleClient, wsDataServerClient } from '@rm-toddle/integrations';
import {
  impressaoDe,
  instanteNoFuso,
  maiorCarimbo,
  recuarCarimboDoToddle,
  recuarRelogioDeParede,
  separarNovidades,
  type LinhaObservada,
  type MemoriaDeVistos,
} from '@rm-toddle/domain';
// Import DEEP de propósito: o index de `queues` abre o Redis ao ser carregado,
// e estas sondas também rodam pelo CLI (`npm run continuo:sondar`), que precisa
// encerrar. Ver importDoIndex.test.ts.
import { FLOW, type FlowKey } from '@rm-toddle/queues/src/fluxos';
import { DETECTOR, type ChaveDeDetector } from '@rm-toddle/queues/src/detectores';

/**
 * AS SONDAS — a pergunta "mudou algo?" de cada detector, contra a origem real.
 *
 * Uma sonda LÊ e devolve o que viu. Não enfileira, não escreve, não decide se o
 * fluxo está ligado: isso é do laço em `detectores.ts`. Separada assim, ela roda
 * igual pelo worker e pelo CLI de diagnóstico.
 *
 * ─── A PRIMEIRA VOLTA É LINHA DE BASE ───────────────────────────────────────
 *
 * Sem memória, tudo o que a consulta devolve pareceria novo, e ligar um
 * detector dispararia o fluxo na hora por coisas que a varredura agendada já
 * levou. A primeira volta só aprende o que existe; a partir da segunda, o que
 * aparecer é novidade de verdade.
 */

export interface ResultadoDaSonda {
  primeiraVez: boolean;
  /** Quantas linhas novas (ou alteradas) a sonda viu. */
  novidades: number;
  /** Os fluxos que essas novidades pedem. Vazio quando não há novidade. */
  fluxos: FlowKey[];
  /** Para quem opera: "3 notas novas em 2 turmas". */
  resumo: string;
  /** A memória para a próxima volta. */
  estado: Record<string, unknown>;
  /** Quanto custou: chamadas a cada sistema nesta volta. */
  chamadas: { toddle: number; rm: number };
}

export type Sonda = (estado: Record<string, unknown>, agora: Date) => Promise<ResultadoDaSonda>;

const folgaMs = (): number => env.CONTINUO_FOLGA_MIN * 60_000;
const plural = (n: number, um: string, muitos: string): string => `${n} ${n === 1 ? um : muitos}`;

/** As turmas do de-para, pelo id do Toddle. É o escopo das duas sondas do Toddle. */
async function turmasDoDePara(): Promise<Set<string>> {
  const cursos = await idMappingRepository.listByType('COURSE', 'active');
  return new Set(cursos.map((c) => String(c.toddleId)));
}

// ─── NOTAS (Toddle → TOTVS) ─────────────────────────────────────────────────

interface EstadoNotas {
  /**
   * Marca e memória POR CURRÍCULO. Uma leitura truncada num currículo não pode
   * adiantar a do outro, e um currículo sem nota nenhuma não pode prender a
   * memória do outro no passado.
   */
  porCurriculo?: Record<string, { desde: string; vistos: MemoriaDeVistos }>;
  curriculos?: { ids: string[]; em: string };
}

/** A lista de currículos muda quase nunca. Relê a cada 6h em vez de a cada volta. */
const RENOVAR_CURRICULOS_MS = 6 * 3_600_000;

/**
 * `published_at` vem SEM fuso, e o fuso do Toddle não é documentado. A marca
 * inicial é "ontem à meia-noite" em UTC: qualquer que seja o fuso deles (o
 * Brasil está 3h atrás), a janela cobre o dia de hoje inteiro. A partir dali,
 * a marca vem SEMPRE do próprio `published_at` lido — nunca do nosso relógio —,
 * então o fuso deixa de importar.
 */
function marcaInicialDoToddle(agora: Date): string {
  return `${new Date(agora.getTime() - 86_400_000).toISOString().slice(0, 10)} 00:00:00`;
}

export const sondarNotas: Sonda = async (bruto, agora) => {
  const e = bruto as EstadoNotas;
  let chamadasToddle = 0;

  let curriculos = e.curriculos;
  if (!curriculos || agora.getTime() - Date.parse(curriculos.em) > RENOVAR_CURRICULOS_MS) {
    const lista = await toddleClient.listCurriculums();
    chamadasToddle += 1;
    curriculos = { ids: lista.map((c) => String(c.id)).filter(Boolean), em: agora.toISOString() };
  }
  if (curriculos.ids.length === 0) {
    throw new Error('o Toddle não devolveu nenhum currículo — nada a sondar, e isso não é "sem novidade"');
  }

  const nossas = await turmasDoDePara();
  if (nossas.size === 0) {
    // Sem de-para, toda nota seria "de turma de fora" e a resposta seria
    // "nenhuma nota nova" para sempre — o silêncio que parece saúde.
    throw new Error('nenhuma turma ativa no de-para — a sonda de notas não tem o que perguntar');
  }
  const anterior = e.porCurriculo ?? {};
  const porCurriculo: NonNullable<EstadoNotas['porCurriculo']> = {};
  const novasTurmas = new Set<string>();
  let novas = 0;
  let vistasNaBase = 0;
  let lidas = 0;
  let foraDoDePara = 0;

  for (const c of curriculos.ids) {
    const desde = anterior[c]?.desde ?? marcaInicialDoToddle(agora);
    // A consulta começa ANTES da marca, pela folga: nota cujo `published_at`
    // fica visível um pouco depois do carimbo (gravação lenta, relógio deles)
    // cairia antes da marca e escaparia. A memória descarta a repetição.
    const consulta = recuarCarimboDoToddle(desde, folgaMs());
    const { notas } = await toddleClient.listarNotasPublicadas({ curriculumProgramId: c, fromDate: consulta });
    chamadasToddle += 1; // ao menos uma; páginas extras são raras e o limitador as conta
    lidas += notas.length;

    // A ordem é crescente: o maior lido é o fim do PREFIXO lido, e avançar até
    // ele é seguro mesmo quando a leitura parou no teto de páginas.
    let marca = desde;
    const linhas: Array<LinhaObservada & { turma: string }> = [];
    for (const n of notas) {
      if (!n.published_at) continue;
      marca = maiorCarimbo(marca, n.published_at) ?? marca;
      // Turma fora do de-para (as de demonstração, no sandbox) não dispara
      // nada. Sem `class_id` a nota CONTA: na dúvida, a varredura decide.
      if (n.class_id && !nossas.has(String(n.class_id))) {
        foraDoDePara += 1;
        continue;
      }
      linhas.push({
        impressao: impressaoDe('NOTA', {
          id: n.id,
          publicada: n.published_at,
          alterada: n.updated_at ?? null,
          valor: n.value ?? null,
        }),
        carimbo: n.published_at,
        turma: String(n.class_title ?? n.class_id ?? '?'),
      });
    }

    const r = separarNovidades(linhas, anterior[c]?.vistos ?? {}, recuarCarimboDoToddle(marca, folgaMs()));
    porCurriculo[c] = { desde: marca, vistos: r.vistos };
    if (anterior[c]) {
      novas += r.novas.length;
      for (const n of r.novas) novasTurmas.add(linhas.find((l) => l.impressao === n.impressao)?.turma ?? '?');
    } else {
      vistasNaBase += linhas.length;
    }
  }

  const primeiraVez = e.porCurriculo === undefined;
  logger.debug({ lidas, foraDoDePara, novas, primeiraVez }, 'Sonda de notas');

  const fora = foraDoDePara > 0 ? ` (${plural(foraDoDePara, 'nota', 'notas')} de turma fora do de-para, ignorada${foraDoDePara === 1 ? '' : 's'})` : '';
  return {
    primeiraVez,
    novidades: novas,
    fluxos: novas > 0 ? [FLOW.NOTAS] : [],
    resumo: (primeiraVez
      ? `linha de base: ${plural(vistasNaBase, 'nota publicada', 'notas publicadas')} desde a marca inicial`
      : novas > 0
        ? `${plural(novas, 'nota nova', 'notas novas')} em ${plural(novasTurmas.size, 'turma', 'turmas')}`
        : 'nenhuma nota nova') + fora,
    estado: { porCurriculo, curriculos } satisfies EstadoNotas,
    chamadas: { toddle: chamadasToddle, rm: 0 },
  };
};

// ─── FREQUÊNCIA (Toddle → TOTVS) ────────────────────────────────────────────

interface EstadoFrequencia {
  /** ISO com Z — o formato do `lastModifiedTimeStamp`. */
  desde?: string;
  vistos?: MemoriaDeVistos;
  /** O `modifiedSince` da última volta e o total que ele devolveu. */
  base?: string;
  total?: number;
}

export const sondarFrequencia: Sonda = async (bruto, agora) => {
  const e = bruto as EstadoFrequencia;
  const nossas = await turmasDoDePara();
  if (nossas.size === 0) {
    throw new Error('nenhuma turma ativa no de-para — a sonda de frequência não tem o que perguntar');
  }

  const piso = new Date(agora.getTime() - folgaMs()).toISOString();
  const desde = e.desde ?? piso;
  // O filtro só aceita DIA. Um dia antes da marca cobre a virada da meia-noite
  // em qualquer fuso, e o recorte fino é feito aqui, pelo carimbo.
  const base = new Date(Date.parse(desde) - 86_400_000).toISOString().slice(0, 10);

  const { totalCount, registros } = await toddleClient.sondarFrequencia({
    modifiedSince: base,
    courseIds: [...nossas],
    count: 100,
  });

  const linhas: LinhaObservada[] = registros
    .filter((r) => r.lastModifiedTimeStamp && r.lastModifiedTimeStamp >= desde)
    .map((r) => ({
      impressao: impressaoDe('FREQ', {
        id: r.id,
        alterado: r.lastModifiedTimeStamp,
        opcao: r.attendanceOption?.abbreviation ?? null,
        apagado: r.isDeleted ?? false,
      }),
      carimbo: String(r.lastModifiedTimeStamp),
    }));

  const desdeNovo = maiorCarimbo(desde, piso) ?? piso;
  const { novas, vistos } = separarNovidades(linhas, e.vistos ?? {}, desdeNovo);
  const primeiraVez = e.desde === undefined;

  // O total só compara com a MESMA base: quando o dia vira, a base anda e o
  // total muda por isso, sem ninguém ter lançado nada.
  const totalMudou = e.base === base && e.total !== undefined && e.total !== totalCount;
  const novidades = primeiraVez ? 0 : novas.length > 0 ? novas.length : totalMudou ? 1 : 0;

  return {
    primeiraVez,
    novidades,
    fluxos: novidades > 0 ? [FLOW.FREQUENCIA] : [],
    resumo: primeiraVez
      ? `linha de base: ${plural(totalCount, 'registro alterado', 'registros alterados')} desde ${base}`
      : novas.length > 0
        ? `${plural(novas.length, 'lançamento de chamada', 'lançamentos de chamada')} novo(s) ou alterado(s)`
        : totalMudou
          ? `o total de registros alterados mudou (${e.total} → ${totalCount})`
          : 'nenhuma chamada nova',
    estado: { desde: desdeNovo, vistos, base, total: totalCount } satisfies EstadoFrequencia,
    chamadas: { toddle: 1, rm: 0 },
  };
};

// ─── CADASTROS (TOTVS → Toddle) ─────────────────────────────────────────────

interface FonteDeCadastro {
  chave: string;
  rotulo: [string, string];
  dataServer: string;
  /** Tabela qualificada no filtro — sem qualificar, "Ambiguous column name". */
  tabela: string;
  elemento: string;
  /** Filtro de escopo, antes do `RECMODIFIEDON`. */
  escopo: (coligada: string | number, filial: string | null) => string | null;
  fluxos: FlowKey[];
}

/**
 * As cinco fontes, cada uma com o filtro `RECMODIFIEDON >` aplicado no
 * SERVIDOR do RM. Medido em 09/10/2026 nos cinco DataServers: com data futura
 * todos devolvem zero linhas (o filtro funciona), e sem mudança cada consulta
 * custa 0,3–0,7 s.
 *
 * `EduMatricPLData` e `RhuPessoaData` filtram pela coluna mas NÃO a devolvem —
 * por isso a memória de impressões, e não uma marca d'água lida.
 *
 * Pessoa dispara só Alunos: o sync de professor CRIA staff e nunca atualiza o
 * e-mail (é a identidade da conta), então mudança em `PPESSOA` não tem o que
 * levar para ele.
 */
const FONTES: FonteDeCadastro[] = [
  {
    chave: 'SALUNO', rotulo: ['aluno', 'alunos'], dataServer: 'EduAlunoData', tabela: 'SALUNO', elemento: 'SAluno',
    escopo: (c) => `SALUNO.CODCOLIGADA=${c}`, fluxos: [FLOW.ALUNOS],
  },
  {
    chave: 'PPESSOA', rotulo: ['pessoa', 'pessoas'], dataServer: 'RhuPessoaData', tabela: 'PPESSOA', elemento: 'PPESSOA',
    escopo: () => null, fluxos: [FLOW.ALUNOS],
  },
  {
    chave: 'SMATRICPL', rotulo: ['matrícula', 'matrículas'], dataServer: 'EduMatricPLData', tabela: 'SMATRICPL', elemento: 'SMatricPL',
    escopo: (c, f) => `SMATRICPL.CODCOLIGADA=${c}${f ? ` AND SMATRICPL.CODFILIAL=${f}` : ''}`, fluxos: [FLOW.ALUNOS],
  },
  {
    chave: 'SPROFESSOR', rotulo: ['professor', 'professores'], dataServer: 'EduProfessorData', tabela: 'SPROFESSOR', elemento: 'SProfessor',
    escopo: (c) => `SPROFESSOR.CODCOLIGADA=${c}`, fluxos: [FLOW.PROFESSORES],
  },
  {
    chave: 'STURMADISC', rotulo: ['turma-disciplina', 'turmas-disciplina'], dataServer: 'EduTurmaDiscData', tabela: 'STURMADISC', elemento: 'STURMADISC',
    escopo: (c, f) => `STURMADISC.CODCOLIGADA=${c}${f ? ` AND STURMADISC.CODFILIAL=${f}` : ''}`,
    fluxos: [FLOW.PROFESSORES, FLOW.TURMAS],
  },
];

interface EstadoCadastro {
  vistos?: MemoriaDeVistos;
  iniciado?: boolean;
  /**
   * Relógio do RM no começo da última volta BEM-SUCEDIDA. A próxima consulta
   * parte dela (menos a folga), e não de "agora menos a folga": entre duas voltas
   * pode passar muito mais que a folga — intervalo de 30 min, falhas seguidas,
   * pausa por credencial, deploy —, e o que mudou nesse vão escaparia.
   */
  ultimaVoltaOk?: string;
}

/** Relógio do RM à frente do nosso além disto = fuso errado ou servidor torto. */
const TOLERANCIA_DE_RELOGIO_MS = 2 * 60_000;
/**
 * O vão mais longo que uma volta recupera. Depois de um dia parado, quem leva
 * as mudanças é a varredura agendada; o detector recomeça perto do presente em
 * vez de despejar um dia inteiro de linhas numa volta só.
 */
const VAO_MAXIMO_MS = 24 * 3_600_000;

/**
 * Das linhas de aluno/pessoa que mudaram, quais são de alunos DESTA integração.
 *
 * O filtro do RM não aceita subconsulta ("Instruções SQL proibidas", medido em
 * 09/10/2026), então `PPESSOA` não dá para recortar no servidor: qualquer pessoa
 * da base — responsável financeiro, funcionário — apareceria. Aqui o recorte é
 * feito depois: pessoa vira RA por um `SALUNO ... CODPESSOA IN (...)` (lista
 * literal, que o RM aceita), e RA só conta se estiver no de-para.
 *
 * Só roda quando há linha nova de aluno ou pessoa, que é raro (~1 por dia útil
 * medido em agosto), então a consulta extra não pesa.
 */
export async function relevantesParaAlunos(
  rasDeAluno: string[],
  pessoas: string[],
  coligada: string | number,
  contexto: string,
): Promise<{ ras: Set<string>; chamadas: number }> {
  const ras = new Set(rasDeAluno);
  let chamadas = 0;
  const codigos = pessoas.filter((p) => /^\d+$/.test(p));
  if (codigos.length > 0) {
    const rows = await wsDataServerClient.readView(
      'EduAlunoData',
      `SALUNO.CODCOLIGADA=${coligada} AND SALUNO.CODPESSOA IN (${codigos.slice(0, 200).join(',')})`,
      'SAluno',
      contexto,
    );
    chamadas += 1;
    for (const r of rows) if (r.RA) ras.add(r.RA);
  }
  if (ras.size === 0) return { ras, chamadas };
  const mapeados = new Set((await idMappingRepository.listByType('STUDENT', 'active')).map((m) => m.rmCode));
  return { ras: new Set([...ras].filter((ra) => mapeados.has(ra))), chamadas };
}

export const sondarCadastros: Sonda = async (bruto, agora) => {
  const e = bruto as EstadoCadastro;
  const fuso = env.CONTINUO_RM_FUSO;
  const agoraRm = instanteNoFuso(agora, fuso);
  const limiteDoRelogio = instanteNoFuso(new Date(agora.getTime() + TOLERANCIA_DE_RELOGIO_MS), fuso);
  const piso = instanteNoFuso(new Date(agora.getTime() - VAO_MAXIMO_MS), fuso);
  const pelaFolga = instanteNoFuso(new Date(agora.getTime() - folgaMs()), fuso);
  // Da última volta boa (menos a folga), mas nunca antes do vão máximo.
  const pelaUltimaVolta = e.ultimaVoltaOk ? recuarRelogioDeParede(e.ultimaVoltaOk, folgaMs()) : pelaFolga;
  const maisAntigo = pelaUltimaVolta < pelaFolga ? pelaUltimaVolta : pelaFolga;
  const desde = maisAntigo < piso ? piso : maisAntigo;

  const campi = tenantConfig.rm.escopo.filiais.split(',').map((x) => x.trim()).filter(Boolean);
  const campusUnico = tenantConfig.rm.escopo.filiais.toUpperCase() !== 'ALL' && campi.length === 1 ? campi[0] : null;
  const contexto = campusUnico ?? campi[0] ?? '1';
  const coligada = tenantConfig.rm.escopo.coligada;

  const linhas: Array<LinhaObservada & { fonte: FonteDeCadastro; linha: Record<string, string> }> = [];
  let chamadas = 0;
  let aFrente = 0;
  // Em sequência, não em paralelo: se o RM recusar a credencial, a PRIMEIRA
  // recusa interrompe a volta. Cinco consultas em paralelo seriam cinco
  // recusas de uma vez — quase o limite que bloqueia o usuário no RM.
  for (const fonte of FONTES) {
    const escopo = fonte.escopo(coligada, campusUnico);
    const filtro = `${escopo ? `${escopo} AND ` : ''}${fonte.tabela}.RECMODIFIEDON > '${desde}'`;
    const rows = await wsDataServerClient.readView(fonte.dataServer, filtro, fonte.elemento, contexto);
    chamadas += 1;
    for (const r of rows) {
      const carimbo = r.RECMODIFIEDON || agoraRm;
      if (r.RECMODIFIEDON && r.RECMODIFIEDON > limiteDoRelogio) aFrente += 1;
      linhas.push({ impressao: impressaoDe(fonte.chave, r), carimbo, fonte, linha: r });
    }
  }

  if (aFrente > 0) {
    logger.warn(
      { aFrente, agoraRm, fuso },
      'Detector de cadastros: o RM tem RECMODIFIEDON à frente do nosso relógio — confira ' +
        'CONTINUO_RM_FUSO. Com o fuso errado a folga encolhe e mudança pode escapar até a varredura.',
    );
  }

  const { novas, vistos } = separarNovidades(linhas, e.vistos ?? {}, desde);
  const primeiraVez = !e.iniciado;
  const novasLinhas = novas
    .map((n) => linhas.find((l) => l.impressao === n.impressao))
    .filter((l): l is (typeof linhas)[number] => Boolean(l));

  // Aluno e pessoa só contam se forem de aluno do de-para. Matrícula, professor
  // e turma-disciplina já vêm recortados por coligada e campus no filtro.
  const deAluno = novasLinhas.filter((l) => l.fonte.chave === 'SALUNO' || l.fonte.chave === 'PPESSOA');
  let relevantesDeAluno = 0;
  if (!primeiraVez && deAluno.length > 0) {
    const r = await relevantesParaAlunos(
      deAluno.filter((l) => l.fonte.chave === 'SALUNO').map((l) => l.linha.RA).filter(Boolean),
      deAluno.filter((l) => l.fonte.chave === 'PPESSOA').map((l) => l.linha.CODIGO).filter(Boolean),
      coligada,
      contexto,
    );
    chamadas += r.chamadas;
    relevantesDeAluno = r.ras.size;
  }

  const porFonte = new Map<FonteDeCadastro, number>();
  for (const l of novasLinhas) {
    if ((l.fonte.chave === 'SALUNO' || l.fonte.chave === 'PPESSOA') && relevantesDeAluno === 0) continue;
    porFonte.set(l.fonte, (porFonte.get(l.fonte) ?? 0) + 1);
  }
  const ignoradas = deAluno.length > 0 && relevantesDeAluno === 0 ? deAluno.length : 0;
  const fluxos = primeiraVez ? [] : [...new Set([...porFonte.keys()].flatMap((f) => f.fluxos))];
  const novidades = primeiraVez ? 0 : [...porFonte.values()].reduce((a, b) => a + b, 0);

  return {
    primeiraVez,
    novidades,
    fluxos,
    resumo: primeiraVez
      ? `linha de base: ${plural(linhas.length, 'registro alterado', 'registros alterados')} desde ${desde.slice(11, 16)}`
      : porFonte.size > 0
        ? [...porFonte].map(([f, n]) => plural(n, f.rotulo[0], f.rotulo[1])).join(', ') + ' alterado(s) no RM'
        : ignoradas > 0
          ? `${plural(ignoradas, 'pessoa alterada', 'pessoas alteradas')} no RM, nenhuma é aluno do de-para`
          : 'nenhum cadastro alterado',
    estado: { vistos, iniciado: true, ultimaVoltaOk: agoraRm } satisfies EstadoCadastro,
    chamadas: { toddle: 0, rm: chamadas },
  };
};

export const SONDAS: Record<ChaveDeDetector, Sonda> = {
  [DETECTOR.NOTAS]: sondarNotas,
  [DETECTOR.FREQUENCIA]: sondarFrequencia,
  [DETECTOR.CADASTRO]: sondarCadastros,
};
