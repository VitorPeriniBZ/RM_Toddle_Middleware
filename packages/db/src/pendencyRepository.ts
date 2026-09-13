import { logger, tenantConfig } from '@rm-toddle/config';
import { pgPool } from './pool';
import type { EntidadeRm } from './provenanceRepository';

/** Config da escola atendida por este processo. */
const cfg = tenantConfig;

/**
 * Fila de pendências: o que a integração se RECUSOU a escrever no RM.
 *
 * Ver a migration 010 para o desenho. Em uma frase: os três vereditos de
 * `decidirEscrita` que exigem olho humano aterram aqui, uma linha por chave, e a
 * redetecção não duplica nem reabre o que já foi decidido — a não ser que o valor
 * desejado tenha mudado.
 *
 * ─── POSTURA DE ERRO ────────────────────────────────────────────────────────
 *
 * `registrarPendencia` **nunca lança**, ao contrário de `registrarEscrita`.
 *
 * A assimetria é deliberada. Falhar ao gravar proveniência é perigoso: na próxima
 * passada a linha viraria conflito, ou pior, alguém trataria a ausência como
 * autorização. Já falhar ao gravar uma pendência é ruim mas não destrutivo — o
 * registro NÃO foi escrito no RM (é isso que "pendência" significa), então o dado
 * do professor está intacto; perdeu-se a anotação de que alguém precisa olhar. E
 * a mesma recusa será redetectada em horas, porque o cron roda 4x ao dia.
 *
 * Entre derrubar um run inteiro e perder um item de fila que se auto-recria,
 * perder o item custa menos.
 */

/**
 * O que pode aterrar nesta fila.
 *
 * Os três primeiros vêm de `decidirEscrita`. `OPCAO_SEM_POLITICA` vem da
 * PROJEÇÃO (migration 012) e é a exceção deliberada: um código de chamada sem
 * par em PRESENCA não é defeito de dado, é decisão de escola pendente — e sem
 * ela o aluno fica sem frequência no RM, em silêncio.
 */
export type VereditoPendente =
  | 'CONFLITO_HUMANO'
  | 'EDITADO_POR_FORA'
  | 'REMOCAO_PEDE_HUMANO'
  | 'OPCAO_SEM_POLITICA'
  /** O RM recusou ESTA linha. Só se descobre tentando — ver a migration 013. */
  | 'RM_RECUSOU'
  /**
   * As três da via de NOTA — recusas de projeção que são decisão de gente, não
   * defeito de dado. Ver a migration 014 para o porquê de cada uma e para a
   * convenção de chave sintética.
   */
  | 'JANELA_INCOMPATIVEL'
  | 'VALOR_NAO_NUMERICO'
  | 'ETAPA_NAO_LIBERADA';
export type EstadoPendencia = 'aberta' | 'resolvida' | 'ignorada';

export interface RegistrarPendenciaArgs {
  entidade: EntidadeRm;
  chaveNatural: string;
  campo?: string;
  veredito: VereditoPendente;
  porque: string;
  valorDesejado?: string | null;
  valorNoRm?: string | null;
  /** Hash do valor desejado. É por ele que se decide reabrir. */
  hashDesejado: string;
  origemId?: string;
  runId?: string | null;
}

export interface Pendencia {
  id: string;
  entidade: string;
  chaveNatural: string;
  campo?: string;
  veredito: string;
  porque: string;
  valorDesejado?: string;
  valorNoRm?: string;
  origemId?: string;
  estado: EstadoPendencia;
  resolucao?: string;
  detectadaEm: string;
  vistoEm: string;
  vezesVista: number;
}

let tenantIdCache: string | null = null;
async function tenantId(): Promise<string> {
  if (tenantIdCache) return tenantIdCache;
  const { rows } = await pgPool.query<{ id: string }>(
    "SELECT id FROM tenant WHERE slug = $1 AND status = 'active'",
    [cfg.slug],
  );
  if (!rows[0]) {
    throw new Error(`TENANT_SLUG="${cfg.slug}" não existe (ou está suspenso) na tabela tenant.`);
  }
  const resolvido = rows[0].id;
  tenantIdCache = resolvido;
  return resolvido;
}

/**
 * Registra (ou reencontra) uma pendência.
 *
 * ─── A REGRA DE REABERTURA ──────────────────────────────────────────────────
 *
 * O `ON CONFLICT` abaixo é o coração deste módulo, então vale ler devagar:
 *
 *   - `vezes_vista` sempre incrementa e `visto_em` sempre avança: é assim que se
 *     distingue "apareceu hoje" de "está aí há três semanas".
 *   - `estado` só volta para `'aberta'` se o `hash_desejado` MUDOU. Se o professor
 *     não mexeu no Toddle, a decisão de quem resolveu continua valendo, e reabrir
 *     transformaria a fila em ruído permanente — o cron roda 4x ao dia.
 *   - quando reabre, `resolucao`/`resolvido_por`/`resolvido_em` são LIMPOS: a
 *     decisão anterior foi sobre outro valor, e mantê-la faria parecer que
 *     alguém já analisou este conflito. Não analisou.
 *   - `detectada_em` nunca muda: é a idade real da pendência.
 *
 * Devolve `true` quando a pendência está aberta depois desta chamada.
 */
export async function registrarPendencia(args: RegistrarPendenciaArgs): Promise<boolean> {
  try {
    const { rows } = await pgPool.query<{ estado: string }>(
      `INSERT INTO write_pendency
         (tenant_id, entidade, chave_natural, campo, veredito, porque,
          valor_desejado, valor_no_rm, hash_desejado, origem_id, run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (tenant_id, entidade, chave_natural, coalesce(campo, ''))
       DO UPDATE SET
         veredito       = EXCLUDED.veredito,
         porque         = EXCLUDED.porque,
         valor_desejado = EXCLUDED.valor_desejado,
         valor_no_rm    = EXCLUDED.valor_no_rm,
         origem_id      = COALESCE(EXCLUDED.origem_id, write_pendency.origem_id),
         visto_em       = now(),
         vezes_vista    = write_pendency.vezes_vista + 1,
         estado         = CASE
                            WHEN write_pendency.hash_desejado <> EXCLUDED.hash_desejado
                              THEN 'aberta'
                            ELSE write_pendency.estado
                          END,
         resolucao      = CASE
                            WHEN write_pendency.hash_desejado <> EXCLUDED.hash_desejado
                              THEN NULL ELSE write_pendency.resolucao
                          END,
         resolvido_por  = CASE
                            WHEN write_pendency.hash_desejado <> EXCLUDED.hash_desejado
                              THEN NULL ELSE write_pendency.resolvido_por
                          END,
         resolvido_em   = CASE
                            WHEN write_pendency.hash_desejado <> EXCLUDED.hash_desejado
                              THEN NULL ELSE write_pendency.resolvido_em
                          END,
         hash_desejado  = EXCLUDED.hash_desejado,
         -- Aponta para o run MAIS RECENTE que viu esta pendência. Mantido no
         -- primeiro, ele mandaria quem investiga ler um run de dias atrás e
         -- concluir que o problema é velho. COALESCE preserva o anterior
         -- quando a passada atual não tem run (ensaio).
         run_id         = COALESCE(EXCLUDED.run_id, write_pendency.run_id)
       RETURNING estado`,
      [
        await tenantId(),
        args.entidade,
        args.chaveNatural,
        args.campo ?? null,
        args.veredito,
        args.porque,
        args.valorDesejado ?? null,
        args.valorNoRm ?? null,
        args.hashDesejado,
        args.origemId ?? null,
        args.runId ?? null,
      ],
    );
    return rows[0]?.estado === 'aberta';
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, entidade: args.entidade, chave: args.chaveNatural },
      'Não foi possível registrar a pendência — o registro NÃO foi escrito no RM, ' +
        'então o dado está intacto; a recusa será redetectada na próxima passada',
    );
    return false;
  }
}

export interface ListarPendenciasArgs {
  estado?: EstadoPendencia;
  entidade?: EntidadeRm;
  veredito?: VereditoPendente;
  limite?: number;
}

export async function listarPendencias(args: ListarPendenciasArgs = {}): Promise<Pendencia[]> {
  const { rows } = await pgPool.query<{
    id: string;
    entidade: string;
    chave_natural: string;
    campo: string | null;
    veredito: string;
    porque: string;
    valor_desejado: string | null;
    valor_no_rm: string | null;
    origem_id: string | null;
    estado: string;
    resolucao: string | null;
    detectada_em: Date;
    visto_em: Date;
    vezes_vista: number;
  }>(
    `SELECT id, entidade, chave_natural, campo, veredito, porque,
            valor_desejado, valor_no_rm, origem_id, estado, resolucao,
            detectada_em, visto_em, vezes_vista
       FROM write_pendency
      WHERE tenant_id = $1
        AND ($2::text IS NULL OR estado = $2)
        AND ($3::text IS NULL OR entidade = $3)
        AND ($4::text IS NULL OR veredito = $4)
      ORDER BY visto_em DESC
      LIMIT $5`,
    [
      await tenantId(),
      args.estado ?? null,
      args.entidade ?? null,
      args.veredito ?? null,
      args.limite ?? 50,
    ],
  );
  return rows.map((r) => ({
    id: r.id,
    entidade: r.entidade,
    chaveNatural: r.chave_natural,
    campo: r.campo ?? undefined,
    veredito: r.veredito,
    porque: r.porque,
    valorDesejado: r.valor_desejado ?? undefined,
    valorNoRm: r.valor_no_rm ?? undefined,
    origemId: r.origem_id ?? undefined,
    estado: r.estado as EstadoPendencia,
    resolucao: r.resolucao ?? undefined,
    detectadaEm: new Date(r.detectada_em).toISOString(),
    vistoEm: new Date(r.visto_em).toISOString(),
    vezesVista: r.vezes_vista,
  }));
}

/**
 * Marca uma pendência como decidida.
 *
 * `quem` é obrigatório e o CHECK da tabela o exige junto do `resolvido_em`:
 * pendência resolvida sem responsável é pendência por que ninguém responde, e o
 * ponto inteiro desta fila é que a decisão tem dono.
 *
 * Não altera nada no RM nem no Toddle — é anotação. Quem corrige, corrige no
 * sistema certo, à mão.
 */
export async function resolverPendencia(
  id: string,
  quem: string,
  resolucao: string,
  ignorar = false,
): Promise<boolean> {
  const { rowCount } = await pgPool.query(
    `UPDATE write_pendency
        SET estado = $4, resolucao = $3, resolvido_por = $2, resolvido_em = now()
      WHERE tenant_id = $1 AND id = $5 AND estado = 'aberta'`,
    [await tenantId(), quem, resolucao, ignorar ? 'ignorada' : 'resolvida', id],
  );
  return (rowCount ?? 0) > 0;
}

export interface ResumoPendencias {
  abertas: number;
  porVeredito: Record<string, number>;
  porEntidade: Record<string, number>;
  /** Idade em dias da pendência aberta mais antiga. */
  maisAntigaDias?: number;
  /** Quantas passadas viu a mais insistente. */
  maisVista?: number;
}

/** Para o `npm run runs`, o shadow e (mais tarde) a API. Nunca lança. */
export async function resumoPendencias(): Promise<ResumoPendencias> {
  try {
    const { rows } = await pgPool.query<{
      veredito: string;
      entidade: string;
      n: string;
      mais_antiga: Date | null;
      mais_vista: number | null;
    }>(
      `SELECT veredito, entidade, count(*)::text AS n,
              min(detectada_em) AS mais_antiga, max(vezes_vista) AS mais_vista
         FROM write_pendency
        WHERE tenant_id = $1 AND estado = 'aberta'
        GROUP BY veredito, entidade`,
      [await tenantId()],
    );
    const porVeredito: Record<string, number> = {};
    const porEntidade: Record<string, number> = {};
    let abertas = 0;
    let maisAntiga: Date | undefined;
    let maisVista = 0;
    for (const r of rows) {
      const n = Number(r.n);
      abertas += n;
      porVeredito[r.veredito] = (porVeredito[r.veredito] ?? 0) + n;
      porEntidade[r.entidade] = (porEntidade[r.entidade] ?? 0) + n;
      if (r.mais_antiga && (!maisAntiga || r.mais_antiga < maisAntiga)) maisAntiga = r.mais_antiga;
      if (r.mais_vista && r.mais_vista > maisVista) maisVista = r.mais_vista;
    }
    return {
      abertas,
      porVeredito,
      porEntidade,
      maisAntigaDias: maisAntiga
        ? Math.floor((Date.now() - maisAntiga.getTime()) / 86_400_000)
        : undefined,
      maisVista: maisVista || undefined,
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Não foi possível resumir as pendências');
    return { abertas: 0, porVeredito: {}, porEntidade: {} };
  }
}
