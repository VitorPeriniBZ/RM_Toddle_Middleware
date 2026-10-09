import { logger } from '@rm-toddle/config';
import { pgPool } from './pool';
import type { Executor } from './executor';
import { tenantIdDaAgenda } from './scheduleRepository';

/**
 * Os DETECTORES DE MUDANÇA, na tabela `fluxo_continuo` (migration 022).
 *
 * Mesma divisão da agenda: a tela grava a INTENÇÃO (`ativo`, intervalo, janela
 * de horas) com auditoria na mesma transação; o worker grava a OBSERVAÇÃO (o que
 * viu na última volta). Nenhum dos dois toca a parte do outro.
 */

/** Contagem do dia, no fuso do detector. Zera quando o dia vira. */
export interface ContadoresDoDia {
  dia?: string;
  sondagens?: number;
  mudancas?: number;
  disparos?: number;
}

/** Fluxo disparado -> o que aconteceu com o pedido. */
export type DesfechosDoDisparo = Record<string, string>;

export interface UltimoDisparo {
  desfechos: DesfechosDoDisparo;
  /** O que a sondagem viu, em linguagem de quem opera ("3 notas novas"). */
  resumo: string;
  /** Fluxo -> quando a passada pedida começa (o ritmo pode adiá-la). */
  inicios?: Record<string, string>;
}

export interface Detector {
  chave: string;
  ativo: boolean;
  intervaloSegundos: number;
  horaInicio: number;
  horaFim: number;
  timezone: string;
  atualizadoPor: string | null;
  atualizadoEm: string;
  ultimaSondagemEm: string | null;
  ultimaMudancaEm: string | null;
  ultimoDisparo: UltimoDisparo | null;
  ultimoDisparoEm: string | null;
  ultimoErro: string | null;
  ultimoErroEm: string | null;
  falhasSeguidas: number;
  pausadoAte: string | null;
  contadores: ContadoresDoDia;
}

/** Com a memória da sondagem. Só o worker precisa dela. */
export interface DetectorComEstado extends Detector {
  estado: Record<string, unknown>;
}

interface Linha {
  chave: string;
  ativo: boolean;
  intervalo_segundos: number;
  hora_inicio: number;
  hora_fim: number;
  timezone: string;
  atualizado_por: string | null;
  updated_at: Date;
  ultima_sondagem_em: Date | null;
  ultima_mudanca_em: Date | null;
  ultimo_disparo: UltimoDisparo | null;
  ultimo_disparo_em: Date | null;
  ultimo_erro: string | null;
  ultimo_erro_em: Date | null;
  falhas_seguidas: number;
  pausado_ate: Date | null;
  contadores: ContadoresDoDia | null;
  estado?: Record<string, unknown> | null;
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

function paraDetector(r: Linha): Detector {
  return {
    chave: r.chave,
    ativo: r.ativo,
    intervaloSegundos: Number(r.intervalo_segundos),
    horaInicio: Number(r.hora_inicio),
    horaFim: Number(r.hora_fim),
    timezone: r.timezone,
    atualizadoPor: r.atualizado_por,
    atualizadoEm: new Date(r.updated_at).toISOString(),
    ultimaSondagemEm: iso(r.ultima_sondagem_em),
    ultimaMudancaEm: iso(r.ultima_mudanca_em),
    ultimoDisparo: r.ultimo_disparo,
    ultimoDisparoEm: iso(r.ultimo_disparo_em),
    ultimoErro: r.ultimo_erro,
    ultimoErroEm: iso(r.ultimo_erro_em),
    falhasSeguidas: Number(r.falhas_seguidas),
    pausadoAte: iso(r.pausado_ate),
    contadores: r.contadores ?? {},
  };
}

/*
 * A memória (`estado`) fica FORA da listagem de propósito: são até milhares de
 * impressões por detector, e a tela, que recarrega a cada poucos segundos, não
 * precisa de nenhuma delas.
 */
const COLUNAS = `chave, ativo, intervalo_segundos, hora_inicio, hora_fim, timezone,
                 atualizado_por, updated_at, ultima_sondagem_em, ultima_mudanca_em,
                 ultimo_disparo, ultimo_disparo_em, ultimo_erro, ultimo_erro_em,
                 falhas_seguidas, pausado_ate, contadores`;

export async function listarDetectores(exec: Executor = pgPool): Promise<Detector[]> {
  const { rows } = await exec.query<Linha>(
    `SELECT ${COLUNAS} FROM fluxo_continuo WHERE tenant_id = $1 ORDER BY chave`,
    [await tenantIdDaAgenda(exec)],
  );
  return rows.map(paraDetector);
}

/** A linha inteira, com a memória — é o que o worker lê no começo de cada volta. */
export async function lerDetector(chave: string, exec: Executor = pgPool): Promise<DetectorComEstado | null> {
  const { rows } = await exec.query<Linha>(
    `SELECT ${COLUNAS}, estado FROM fluxo_continuo WHERE tenant_id = $1 AND chave = $2`,
    [await tenantIdDaAgenda(exec), chave],
  );
  if (!rows[0]) return null;
  return { ...paraDetector(rows[0]), estado: rows[0].estado ?? {} };
}

/**
 * Cria a linha do detector, DESLIGADA, se ela ainda não existe.
 *
 * `ON CONFLICT DO NOTHING`: depois da primeira vez, quem decide é a tela. É a
 * precedência de uma via da D8 — um default novo no código nunca reescreve o
 * que alguém escolheu.
 */
export async function semearDetector(
  chave: string,
  padrao: { intervaloSegundos: number; horaInicio: number; horaFim: number },
  exec: Executor = pgPool,
): Promise<boolean> {
  const { rowCount } = await exec.query(
    `INSERT INTO fluxo_continuo (tenant_id, chave, ativo, intervalo_segundos, hora_inicio, hora_fim)
     VALUES ($1, $2, false, $3, $4, $5)
     ON CONFLICT (tenant_id, chave) DO NOTHING`,
    [await tenantIdDaAgenda(exec), chave, padrao.intervaloSegundos, padrao.horaInicio, padrao.horaFim],
  );
  return (rowCount ?? 0) > 0;
}

export interface MudancaDeDetector {
  chave: string;
  ativo?: boolean;
  intervaloSegundos?: number;
  horaInicio?: number;
  horaFim?: number;
  /** Limpa pausa e falhas sem desligar — o "Retomar" da tela. */
  retomar?: boolean;
  atualizadoPor: string;
}

/**
 * Aplica a mudança de intenção. Recebe um `Executor` porque roda dentro da
 * MESMA transação do `audit_event` — se a auditoria falhar, a mudança falha.
 *
 * Desligar também limpa a pausa e a contagem de falhas: quem religa espera um
 * detector novo, não um que ainda está "pausado até 15:30" por um problema que
 * já foi resolvido.
 *
 * LIGAR zera a memória (`estado`). Sem isso, um detector religado depois de
 * semanas retomaria da marca antiga: leria semanas de notas, dispararia o fluxo
 * a cada volta até alcançar o presente, e quebraria a promessa de que ligar não
 * dispara nada pelo que já existia. A primeira volta depois de ligar é linha de
 * base; o que ficou para trás a varredura agendada já levou.
 */
export async function alterarDetector(
  exec: Executor,
  m: MudancaDeDetector,
): Promise<{ antes: Detector; depois: Detector } | null> {
  const tid = await tenantIdDaAgenda(exec);
  const { rows: antesRows } = await exec.query<Linha>(
    `SELECT ${COLUNAS} FROM fluxo_continuo WHERE tenant_id = $1 AND chave = $2 FOR UPDATE`,
    [tid, m.chave],
  );
  if (!antesRows[0]) return null;
  const antes = paraDetector(antesRows[0]);

  const ativo = m.ativo ?? antes.ativo;
  const intervalo = m.intervaloSegundos ?? antes.intervaloSegundos;
  const inicio = m.horaInicio ?? antes.horaInicio;
  const fim = m.horaFim ?? antes.horaFim;
  const retomando = m.retomar === true && (antes.pausadoAte !== null || antes.falhasSeguidas > 0);
  if (
    ativo === antes.ativo &&
    intervalo === antes.intervaloSegundos &&
    inicio === antes.horaInicio &&
    fim === antes.horaFim &&
    !retomando
  ) {
    return { antes, depois: antes };
  }

  const desligando = antes.ativo && !ativo;
  const ligando = !antes.ativo && ativo;
  const extras = [
    desligando || retomando ? 'pausado_ate = NULL, falhas_seguidas = 0' : null,
    ligando ? "estado = '{}'::jsonb, pausado_ate = NULL, falhas_seguidas = 0, ultimo_erro = NULL, ultimo_erro_em = NULL" : null,
  ].filter(Boolean);
  const { rows } = await exec.query<Linha>(
    `UPDATE fluxo_continuo
        SET ativo = $3, intervalo_segundos = $4, hora_inicio = $5, hora_fim = $6,
            atualizado_por = $7, updated_at = now()
            ${extras.length ? `, ${extras.join(', ')}` : ''}
      WHERE tenant_id = $1 AND chave = $2
      RETURNING ${COLUNAS}`,
    [tid, m.chave, ativo, intervalo, inicio, fim, m.atualizadoPor],
  );
  return { antes, depois: paraDetector(rows[0]) };
}

export interface ResultadoDaVolta {
  /** Nova memória. Ausente = mantém a anterior (volta que falhou). */
  estado?: Record<string, unknown>;
  sondou: boolean;
  mudou: boolean;
  disparo?: UltimoDisparo;
  erro: string | null;
  falhasSeguidas: number;
  pausadoAte: Date | null;
  contadores: ContadoresDoDia;
}

/**
 * Grava o que a volta observou.
 *
 * NUNCA lança: é registro de estado, e falhar aqui não pode derrubar o laço do
 * detector — a próxima volta tenta de novo. Mesma regra do `marcarAplicada` da
 * agenda.
 *
 * O erro só é limpo por uma volta que SONDOU com sucesso. Uma volta pulada (fora
 * do horário, pausada) não prova que o problema passou.
 *
 * ─── A VOLTA NÃO PASSA POR CIMA DA TELA ─────────────────────────────────────
 *
 * `versaoLida` é o `atualizadoEm` que a volta leu ao começar. Se alguém mexeu na
 * linha durante a volta — desligou, religou, retomou —, a gravação NÃO acontece:
 * sem isso, a volta em andamento devolveria a pausa que a pessoa acabou de
 * limpar, ou a memória antiga que o religar acabou de zerar. A volta seguinte
 * já parte da linha nova.
 */
export async function registrarVolta(chave: string, versaoLida: string, r: ResultadoDaVolta): Promise<void> {
  try {
    await pgPool.query(
      `UPDATE fluxo_continuo
          SET estado             = COALESCE($3::jsonb, estado),
              ultima_sondagem_em = CASE WHEN $4 THEN now() ELSE ultima_sondagem_em END,
              ultima_mudanca_em  = CASE WHEN $5 THEN now() ELSE ultima_mudanca_em END,
              ultimo_disparo     = COALESCE($6::jsonb, ultimo_disparo),
              ultimo_disparo_em  = CASE WHEN $6::jsonb IS NULL THEN ultimo_disparo_em ELSE now() END,
              ultimo_erro        = CASE WHEN $7::text IS NOT NULL THEN $7
                                        WHEN $4 THEN NULL ELSE ultimo_erro END,
              ultimo_erro_em     = CASE WHEN $7::text IS NOT NULL THEN now()
                                        WHEN $4 THEN NULL ELSE ultimo_erro_em END,
              falhas_seguidas    = $8,
              pausado_ate        = $9,
              contadores         = $10::jsonb
        WHERE tenant_id = $1 AND chave = $2
          AND date_trunc('milliseconds', updated_at) = $11::timestamptz`,
      [
        await tenantIdDaAgenda(),
        chave,
        r.estado === undefined ? null : JSON.stringify(r.estado),
        r.sondou,
        r.mudou,
        r.disparo === undefined ? null : JSON.stringify(r.disparo),
        r.erro?.slice(0, 800) ?? null,
        r.falhasSeguidas,
        r.pausadoAte,
        JSON.stringify(r.contadores),
        versaoLida,
      ],
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, chave },
      'Não foi possível registrar a volta do detector — o laço segue',
    );
  }
}
