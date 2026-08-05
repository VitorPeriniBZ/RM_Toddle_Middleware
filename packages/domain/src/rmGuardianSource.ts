import { createHash } from 'node:crypto';
import { env, isRmSoapConfigured, logger, sanitizeEmail } from '@rm-toddle/config';
import { wsConsultaSqlClient, type ConsultaRow } from '@rm-toddle/integrations';

/**
 * Fonte de RESPONSÁVEIS do RM, via Sentença `TODDLE.RESP`.
 *
 * ─── SÓ O RESPONSÁVEL ACADÊMICO ─────────────────────────────────────────────
 *
 * Decisão da escola em 05/08/2026: apenas o responsável **acadêmico** vira
 * `parent` no Toddle. O financeiro fica de fora.
 *
 * O motivo é concreto, não estético. Criar um `parent` no Toddle **dá acesso ao
 * LMS** — nota, frequência e comunicado do filho. E o lado financeiro contém
 * pessoa jurídica: `bomaluno@institutoponte.org.br` (Instituto Ponte) aparece como
 * responsável financeiro de **8 alunos de 7 famílias diferentes**. Confirmado com
 * a escola que o dado está correto — é um instituto que patrocina bolsa. Mas dar a
 * ele visão do boletim de 8 crianças é decisão que ninguém tomou, então o padrão é
 * não incluir.
 *
 * O corte não perde ninguém: os 253 alunos em escopo têm responsável acadêmico, e
 * 251 deles com e-mail.
 *
 * ─── A CHAVE É O E-MAIL, E ISSO TEM CUSTO ───────────────────────────────────
 *
 * `COD_RESP_ACADEMICO` é um `CODPESSOA` e `COD_RESP_FINANCEIRO` é um `CODCFO` —
 * espaços de identificação diferentes, sem nada que os ligue. Não existe
 * identificador único de pessoa no retorno, então a consolidação é pelo e-mail,
 * que é também a identidade no Toddle.
 *
 * Consequência: se a escola trocar o e-mail de um responsável, ele viraria um
 * `parent` novo. Por isso guardamos `nomeHash` — um hash com sal do nome
 * normalizado — para detectar troca de e-mail em vez de duplicar em silêncio.
 */

/** Um responsável consolidado, pronto para o POST /public/v2/parents. */
export interface Responsavel {
  /** Chave do de-para (id_mapping tipo PARENT). É a identidade no Toddle. */
  email: string;
  nomeCompleto: string;
  /** `firstName` no Toddle. */
  primeiroNome: string;
  /** `lastName` no Toddle. Nunca vazio — ver `divideNome`. */
  sobrenome: string;
  /** Códigos do RM (CODPESSOA). Mais de um = mesma pessoa cadastrada em duplicidade. */
  codigosRm: string[];
  /** `children[]`: RAs. A tradução para studentId é de quem consome. */
  ras: string[];
  /** RA → parentesco declarado, para `relationships[]`. */
  parentescoPorRa: Record<string, string>;
  /** Hash com sal do nome normalizado. Detecta troca de e-mail. Nunca é o nome. */
  nomeHash: string;
}

/** Aluno cujo responsável acadêmico não pode virar parent. Vira pendência, nunca chute. */
export interface PendenciaResponsavel {
  ra: string;
  aluno: string;
  nomeResponsavel?: string;
  motivo: 'SEM_EMAIL' | 'SEM_RESPONSAVEL_ACADEMICO';
}

/** E-mail usado por pessoas com nomes diferentes — no Toddle, só uma pode existir. */
export interface ColisaoEmail {
  email: string;
  nomes: string[];
  ras: string[];
}

export interface ResumoResponsaveis {
  linhas: number;
  /** Linhas fora do escopo de aluno (outros campi, ou aluno não mapeado). */
  foraDoEscopo: number;
  responsaveis: Responsavel[];
  pendencias: PendenciaResponsavel[];
  colisoes: ColisaoEmail[];
  /** Domínio de parentesco observado — detecta valor novo sem ninguém avisar. */
  dominioParentesco: Record<string, number>;
}

/**
 * Divide "Ana Maria Silva" em { primeiro: "Ana", sobrenome: "Maria Silva" }.
 *
 * `lastName` é obrigatório no Toddle. Nome de uma palavra só cairia com sobrenome
 * vazio, então repetimos o primeiro nome — feio, mas explícito, e melhor que a
 * requisição ser recusada ou que inventarmos sobrenome.
 */
export function divideNome(nomeCompleto: string): { primeiro: string; sobrenome: string } {
  const partes = nomeCompleto.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return { primeiro: '', sobrenome: '' };
  if (partes.length === 1) return { primeiro: partes[0], sobrenome: partes[0] };
  return { primeiro: partes[0], sobrenome: partes.slice(1).join(' ') };
}

/** Normaliza para comparar nome: sem acento, sem caixa, espaço colapsado. */
function normalizaNome(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Lê os responsáveis acadêmicos e consolida por e-mail.
 *
 * @param rasEmEscopo RAs com mapeamento STUDENT ativo. Interseção POSITIVA: o que
 *   não estiver aqui não entra, e lista vazia é erro, nunca "todos".
 */
export async function fetchResponsaveisFromRm(rasEmEscopo: string[]): Promise<ResumoResponsaveis> {
  if (!isRmSoapConfigured) {
    throw new Error('wsConsultaSQL não configurado (RM_WS_BASEURL/RM_WS_USER/RM_WS_PASS).');
  }
  if (!env.RM_SENTENCA_RESPONSAVEIS) {
    throw new Error(
      'RM_SENTENCA_RESPONSAVEIS não definido — informe o código da Sentença de responsáveis ' +
        '(ex.: TODDLE.RESP). Ver docs/rm-sentencas/TODDLE.RESP.ESPEC.md.',
    );
  }
  if (!env.RM_CODPERLET) {
    throw new Error('RM_CODPERLET não definido — a Sentença de responsáveis exige o período letivo.');
  }
  if (rasEmEscopo.length === 0) {
    throw new Error(
      'fetchResponsaveisFromRm recebeu lista vazia de RA. Sem escopo não há responsável a ler — ' +
        'isto é recusa, não "ler todos".',
    );
  }

  const rows = await wsConsultaSqlClient.realizarConsulta(env.RM_SENTENCA_RESPONSAVEIS, {
    CODCOLIGADA: env.RM_CODCOLIGADA,
    CODPERLET: env.RM_CODPERLET,
  });

  const emEscopo = new Set(rasEmEscopo);
  const porEmail = new Map<string, Responsavel & { nomesVistos: Set<string> }>();
  const pendencias: PendenciaResponsavel[] = [];
  const dominioParentesco: Record<string, number> = {};
  let foraDoEscopo = 0;

  for (const row of rows) {
    const ra = pick(row, 'RA');
    if (!ra || !emEscopo.has(ra)) {
      foraDoEscopo += 1;
      continue;
    }

    const aluno = pick(row, 'ALUNO') ?? '';
    const nome = pick(row, 'RESP_ACADEMICO');
    if (!nome) {
      pendencias.push({ ra, aluno, motivo: 'SEM_RESPONSAVEL_ACADEMICO' });
      continue;
    }

    // Institucional tem precedência; pessoal é fallback. Mesma ordem do roster.
    const email =
      sanitizeEmail(pick(row, 'EMAIL_ACADEMICO')) ??
      sanitizeEmail(pick(row, 'EMAIL_ACAD_PESSOAL'));
    if (!email) {
      // Sem e-mail não existe parent no Toddle. NÃO inventar endereço.
      pendencias.push({ ra, aluno, nomeResponsavel: nome, motivo: 'SEM_EMAIL' });
      continue;
    }

    const parentesco = pick(row, 'PARENTESCO_ACADEMICO') ?? '';
    const chaveParentesco = parentesco || '(vazio)';
    dominioParentesco[chaveParentesco] = (dominioParentesco[chaveParentesco] ?? 0) + 1;

    const codigo = pick(row, 'COD_RESP_ACADEMICO');
    const chave = email.toLowerCase().trim();
    const existente = porEmail.get(chave);

    if (existente) {
      if (!existente.ras.includes(ra)) existente.ras.push(ra);
      if (parentesco) existente.parentescoPorRa[ra] = parentesco;
      if (codigo && !existente.codigosRm.includes(codigo)) existente.codigosRm.push(codigo);
      existente.nomesVistos.add(nome.trim());
      continue;
    }

    const { primeiro, sobrenome } = divideNome(nome);
    porEmail.set(chave, {
      email: chave,
      nomeCompleto: nome.trim(),
      primeiroNome: primeiro,
      sobrenome,
      codigosRm: codigo ? [codigo] : [],
      ras: [ra],
      parentescoPorRa: parentesco ? { [ra]: parentesco } : {},
      nomeHash: createHash('sha256')
        .update(`${env.TENANT_SLUG}:${normalizaNome(nome)}`)
        .digest('hex')
        .slice(0, 16),
      nomesVistos: new Set([nome.trim()]),
    });
  }

  // Colisão: um e-mail com nomes diferentes. No Toddle o e-mail é a identidade,
  // então só uma pessoa pode existir — quem decide é a escola, não o código.
  const colisoes: ColisaoEmail[] = [];
  const responsaveis: Responsavel[] = [];
  for (const r of porEmail.values()) {
    const nomes = [...r.nomesVistos];
    const distintos = new Set(nomes.map(normalizaNome));
    if (distintos.size > 1) {
      colisoes.push({ email: r.email, nomes: nomes.sort(), ras: [...r.ras].sort() });
    }
    const { nomesVistos: _descartado, ...limpo } = r;
    responsaveis.push(limpo);
  }

  // O log NÃO inclui e-mail nem nome: é dado pessoal, e log JSON vaza para onde
  // ninguém revisou. Mesma regra da frequência (CPF).
  logger.info(
    {
      linhas: rows.length,
      foraDoEscopo,
      responsaveis: responsaveis.length,
      pendencias: pendencias.length,
      colisoes: colisoes.length,
      dominioParentesco,
    },
    'Responsáveis acadêmicos lidos do RM (financeiro excluído por decisão de escopo)',
  );

  return {
    linhas: rows.length,
    foraDoEscopo,
    responsaveis: responsaveis.sort((a, b) => b.ras.length - a.ras.length),
    pendencias,
    colisoes,
    dominioParentesco,
  };
}

/** Busca uma coluna por vários nomes possíveis (case-insensitive), trimada. */
function pick(row: ConsultaRow, ...names: string[]): string | undefined {
  for (const name of names) {
    const direct = row[name];
    if (direct != null && direct !== '') return direct;
  }
  const lowered = new Map(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
  for (const name of names) {
    const v = lowered.get(name.toLowerCase());
    if (v != null && v !== '') return v;
  }
  return undefined;
}
