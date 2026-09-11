import { useEffect, useState } from 'react';
import { api, type PainelDeJobs, type FluxoDeJobs, type JobTerminado, type RunNoGrafico } from '../api';
import { cor, quando, s } from '../estilos';

/**
 * A aba JOBS: o que está rodando agora, e o que rodou antes.
 *
 * ─── NADA AQUI É ESTIMADO ───────────────────────────────────────────────────
 *
 * Barra de progresso só aparece quando existe denominador de verdade:
 *
 *   - fan-out de aluno -> `lotesConcluidos/lotesEsperados`, do Postgres;
 *   - notas e professores -> `feitos/total` da fase, publicado pelo próprio job.
 *
 * Quando o job está LENDO (uma Sentença do RM, as páginas do Toddle), não existe
 * "quanto falta": mostra-se o nome da fase e nenhuma barra. Uma barra animada ali
 * seria uma afirmação falsa, e barra em que não se confia não serve para nada.
 *
 * ─── POR QUE O GRÁFICO COMEÇA QUASE VAZIO ───────────────────────────────────
 *
 * `job_run` acumula uma linha por execução daqui para frente; não existe
 * histórico retroativo. Em vez de esconder o gráfico, ele aparece com o que há e
 * diz quantos runs faltam para virar tendência — esconder faria parecer que a
 * aba está quebrada.
 */
export function Jobs({ aoErrar }: { aoErrar: (e: unknown) => void }) {
  const [dados, setDados] = useState<PainelDeJobs | null>(null);
  const [carregando, setCarregando] = useState(false);

  async function carregar(): Promise<void> {
    setCarregando(true);
    try {
      setDados(await api.jobs());
    } catch (e) {
      aoErrar(e);
    } finally {
      setCarregando(false);
    }
  }

  // Rápido quando há trabalho, devagar quando não há: uma barra de progresso que
  // só anda com F5 não é barra de progresso, mas pedir de 5 em 5 segundos com a
  // fila vazia é só barulho.
  const ocupado = Boolean(dados?.fluxos.some((f) => f.contagem.ativos > 0 || f.contagem.esperando > 0));
  useEffect(() => { void carregar(); }, []);
  useEffect(() => {
    const t = setInterval(() => void carregar(), ocupado ? 3_000 : 30_000);
    return () => clearInterval(t);
  }, [ocupado]);

  if (!dados) return <p style={s.fraco}>{carregando ? 'Lendo as filas…' : '—'}</p>;

  const rodando = dados.fluxos.reduce((n, f) => n + f.contagem.ativos, 0);
  const esperando = dados.fluxos.reduce((n, f) => n + f.contagem.esperando, 0);

  return (
    <>
      <div style={{ ...s.barra, justifyContent: 'space-between' }}>
        <div style={s.linha}>
          <span style={s.selo(rodando > 0 ? 'atencao' : 'neutro')}>
            {rodando > 0 ? 'rodando' : 'parado'}
          </span>
          <Kpi n={rodando} rotulo="rodando" tom={rodando > 0 ? 'atencao' : 'neutro'} />
          <Kpi n={esperando} rotulo="na fila" tom={esperando > 0 ? 'atencao' : 'neutro'} />
          <Kpi n={dados.dlq.total} rotulo="na DLQ" tom={dados.dlq.total > 0 ? 'ruim' : 'neutro'} />
        </div>
        <button style={s.botao} onClick={() => void carregar()} disabled={carregando}>
          {carregando ? 'Atualizando…' : 'Atualizar'}
        </button>
      </div>

      {dados.fluxos.map((f) => (
        <CartaoDeJobs key={f.flowKey} fluxo={f} />
      ))}

      <p style={{ ...s.fraco, marginTop: '1.2rem' }}>
        O histórico durável vem de <code style={s.mono}>job_run</code> ({dados.retencao.duravelEm}).
        O Redis guarda job concluído por {dados.retencao.concluidosNoRedisHoras}h e falho por{' '}
        {dados.retencao.falhosNoRedisDias} dias — passado isso, some de lá, não daqui.
      </p>
    </>
  );
}

function Kpi({ n, rotulo, tom }: { n: number; rotulo: string; tom: 'bom' | 'ruim' | 'atencao' | 'neutro' }) {
  return (
    <div>
      <div style={s.kpiNumero(tom)}>{n}</div>
      <div style={s.kpiRotulo}>{rotulo}</div>
    </div>
  );
}

function CartaoDeJobs({ fluxo }: { fluxo: FluxoDeJobs }) {
  return (
    <div style={s.cartao}>
      <div style={{ ...s.linha, justifyContent: 'space-between' }}>
        <h3 style={s.h3}>{fluxo.rotulo}</h3>
        <span style={s.fraco}>
          {fluxo.contagem.ativos} ativo(s) · {fluxo.contagem.esperando} na fila
          {fluxo.contagem.reservaDeCron > 0 && (
            <span title="o marcador que o BullMQ mantém reservando o próximo disparo do cron — não é trabalho">
              {' '}· {fluxo.contagem.reservaDeCron} reserva de cron
            </span>
          )}
        </span>
      </div>

      <Execucao fluxo={fluxo} />
      <RunsPresos runs={fluxo.runsPresos} />
      <Terminados jobs={fluxo.terminados} />
      <Historico fluxo={fluxo} />
    </div>
  );
}

/**
 * Run que ficou aberto e parou de dar notícia.
 *
 * Um run só fecha quando o último lote reporta. Se um lote morre — 429 do
 * Toddle, worker derrubado no meio — ninguém fecha, e a linha fica `executing`
 * para sempre, com o painel desenhando uma barra que cresce a cada recarga.
 *
 * Aqui isso vira um aviso com o que fazer, em vez de uma animação mentindo.
 */
function RunsPresos({ runs }: { runs: RunNoGrafico[] }) {
  if (runs.length === 0) return null;
  return (
    <div style={s.aviso('ruim')}>
      <strong>{runs.length} run(s) preso(s).</strong> Aberto(s) e sem notícia de lote nenhum —
      ninguém vai fechá-los sozinho, e eles não indicam trabalho em andamento.
      <ul style={{ margin: '.4rem 0 0', paddingLeft: '1.2rem' }}>
        {runs.map((r) => (
          <li key={r.chave} style={{ fontSize: '.85rem' }}>
            <code style={s.mono}>{r.chave}</code> — começou {quando(r.inicioEm)}
            {r.lotes && `, parou em ${r.lotes.feitos}/${r.lotes.total} lotes`}
            {r.semNoticiaHaMs !== undefined && `, sem notícia há ${duracao(r.semNoticiaHaMs)}`}
          </li>
        ))}
      </ul>
      <div style={{ ...s.fraco, marginTop: '.4rem' }}>
        O sync é idempotente: o próximo disparo refaz o que faltou. Este aviso é para o run não
        ficar contando uma história de progresso que não está acontecendo.
      </div>
    </div>
  );
}

/** O que está acontecendo AGORA. Barra só com denominador. */
function Execucao({ fluxo }: { fluxo: FluxoDeJobs }) {
  // O fan-out de aluno: o progresso real é por lote, e vem do Postgres.
  if (fluxo.lotesEmCurso) {
    const { feitos, total } = fluxo.lotesEmCurso;
    return (
      <Barra
        rotulo="processando lotes"
        detalhe={`${feitos}/${total} lotes`}
        fracao={total > 0 ? feitos / total : 0}
      />
    );
  }

  if (fluxo.ativos.length === 0) {
    return <p style={{ ...s.fraco, marginTop: '.6rem' }}>Nada em execução.</p>;
  }

  return (
    <>
      {fluxo.ativos.map((a) => {
        const p = a.progresso;
        const temFracao = p && p.feitos !== undefined && p.total !== undefined;
        return (
          <div key={a.id ?? a.nome} style={{ marginTop: '.6rem' }}>
            {temFracao ? (
              <Barra
                rotulo={p!.fase}
                detalhe={`${p!.feitos}/${p!.total}`}
                fracao={p!.total! > 0 ? p!.feitos! / p!.total! : 0}
              />
            ) : (
              // Sem denominador: o nome da fase, e NENHUMA barra. Ver o
              // cabeçalho deste arquivo.
              <div style={s.linha}>
                <span style={s.selo('atencao')}>em curso</span>
                <span>{p?.fase ?? 'iniciando…'}</span>
                <span style={s.fraco}>
                  sem porcentagem — esta fase é uma leitura, não tem quanto falta
                </span>
              </div>
            )}
            <div style={{ ...s.fraco, marginTop: '.2rem' }}>
              desde {quando(a.iniciadoEm)}
              {a.tentativa > 1 && ` · tentativa ${a.tentativa}`}
            </div>
          </div>
        );
      })}
    </>
  );
}

/**
 * O que acabou de terminar, direto da fila.
 *
 * ─── POR QUE ISTO EXISTE ────────────────────────────────────────────────────
 *
 * Porque `job_run` não cobre tudo. Um job que roda e decide NÃO fazer nada
 * retorna antes de abrir run — é o caso da via de nota com `NOTA_SYNC_ATIVO`
 * em `false`, que devolve `{ desligado: true }` em milissegundos.
 *
 * Sem este bloco, clicar em "Sincronizar agora" nesse fluxo produzia silêncio
 * absoluto: o job rodava, fazia o certo, e a tela continuava dizendo "último
 * sucesso: nunca". Quem clicou não tinha como saber se funcionou.
 *
 * A janela é curta de propósito — é a retenção do Redis (24h/7d). Para prazo
 * maior, o gráfico abaixo, que vem do Postgres.
 */
function Terminados({ jobs }: { jobs: JobTerminado[] }) {
  if (jobs.length === 0) return null;
  return (
    <div style={{ marginTop: '.8rem' }}>
      <div style={s.dadoRotulo}>terminaram nas últimas 24h</div>
      <table style={{ ...s.tabela, marginTop: '.2rem', tableLayout: 'fixed' }}>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id ?? j.terminadoEm}>
              <td style={{ ...s.td, width: 90, whiteSpace: 'nowrap' }}>
                <span style={s.selo(j.desfecho === 'failed' ? 'ruim' : 'bom')}>
                  {j.desfecho === 'failed' ? '✕ falhou' : '✓ ok'}
                </span>
              </td>
              <td style={{ ...s.td, width: 110, whiteSpace: 'nowrap' }}>
                {quando(j.terminadoEm)}
                {j.manual && <span style={s.fraco}> · manual</span>}
              </td>
              <td style={{ ...s.td, width: 70, whiteSpace: 'nowrap' }}>
                {j.duracaoMs === null ? '—' : duracao(j.duracaoMs)}
              </td>
              {/* O retorno é o que explica um job que "rodou e não fez nada".
                  Sem ele, `{desligado:true}` seria invisível. Quebra em qualquer
                  ponto: é JSON, não tem espaço onde quebrar sozinho, e sem isto
                  ele empurra a largura do cartão para fora da tela. */}
              <td style={{ ...s.td, ...s.mono, fontSize: '.78rem', wordBreak: 'break-word' }}>
                {j.erro ?? resumoDoRetorno(j.retorno)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** O retorno em uma linha, com tradução do caso que mais confunde. */
function resumoDoRetorno(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.desligado === true) return 'rodou e não tocou no RM — a via está desligada (NOTA_SYNC_ATIVO=false)';
    if (typeof o.naoEscreveu === 'string') return `não escreveu: ${o.naoEscreveu}`;
  }
  const txt = typeof v === 'string' ? v : JSON.stringify(v);
  return txt.length > 120 ? `${txt.slice(0, 120)}…` : txt;
}

/**
 * A barra.
 *
 * Extremidade arredondada de 4px ancorada na base, trilho recessivo, e o número
 * SEMPRE ao lado em texto — a cor sozinha nunca carrega a informação.
 */
function Barra({ rotulo, detalhe, fracao }: { rotulo: string; detalhe: string; fracao: number }) {
  const pct = Math.round(Math.min(Math.max(fracao, 0), 1) * 100);
  return (
    <div style={{ marginTop: '.6rem' }}>
      <div style={{ ...s.linha, justifyContent: 'space-between', marginBottom: '.25rem' }}>
        <span>{rotulo}</span>
        <span style={s.fraco}>
          {detalhe} · {pct}%
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${rotulo}: ${detalhe}`}
        style={{ height: 10, background: cor.fundoFraco, border: `1px solid ${cor.borda}`, borderRadius: 5 }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: cor.marca,
            borderRadius: 5,
            transition: 'width .4s ease',
          }}
        />
      </div>
    </div>
  );
}

/** Cores de ESTADO. Nunca sozinhas: acompanham glifo e rótulo. */
const TOM_DO_DESFECHO: Record<RunNoGrafico['desfecho'], string> = {
  succeeded: cor.bom,
  failed: cor.ruim,
  executing: cor.atencao,
  preso: cor.ruim,
};
const GLIFO: Record<RunNoGrafico['desfecho'], string> = {
  succeeded: '✓',
  failed: '✕',
  executing: '⋯',
  preso: '!',
};
const NOME_DO_DESFECHO: Record<RunNoGrafico['desfecho'], string> = {
  succeeded: 'sucesso',
  failed: 'falha',
  executing: 'em curso',
  preso: 'preso',
};

function duracao(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seg = ms / 1000;
  if (seg < 90) return `${seg.toFixed(seg < 10 ? 1 : 0)} s`;
  return `${Math.floor(seg / 60)} min ${Math.round(seg % 60)} s`;
}

/**
 * Duração por run, em barras.
 *
 * ─── DECISÕES DE FORMA ──────────────────────────────────────────────────────
 *
 * Barra, e não linha: cada run é um evento discreto, e os intervalos entre eles
 * são desiguais (4x ao dia, mais os manuais). Uma linha ligando pontos sugeriria
 * continuidade que não existe.
 *
 * Eixo único, escala começando em ZERO — duração é magnitude, e truncar a base
 * de uma barra exagera diferença. Sem eixo Y desenhado: o valor exato está no
 * tooltip e no maior rotulado, e grade completa aqui seria ruído.
 *
 * ─── A COR NÃO CARREGA A INFORMAÇÃO SOZINHA ─────────────────────────────────
 *
 * Sucesso/falha em verde/vermelho é exatamente o par que a deuteranopia
 * confunde: o validador da paleta deu ΔE 7.9, dentro da faixa que só é aceitável
 * COM codificação secundária. Então cada barra leva glifo (✓/✕) acima, falha
 * leva hachura a 45°, e a legenda traz os nomes. Em preto e branco continua
 * legível.
 */
function Historico({ fluxo }: { fluxo: FluxoDeJobs }) {
  const runs = [...fluxo.historico].reverse(); // antigo -> recente, como se lê
  const [sobre, setSobre] = useState<number | null>(null);

  if (runs.length === 0) {
    return (
      <p style={{ ...s.fraco, marginTop: '.8rem' }}>
        Nenhum run registrado ainda. O histórico começa no próximo disparo.
      </p>
    );
  }

  /**
   * A escala sai dos runs TERMINADOS.
   *
   * Um run aberto cresce sem limite — um de 116 min achatou quarenta barras de
   * 30s até virarem linha reta, e o gráfico parou de dizer qualquer coisa sobre
   * os que terminaram. O aberto é desenhado na altura máxima e marcado, o que é
   * honesto: ele está FORA da escala, não no topo dela.
   */
  const terminados = runs.filter((r) => r.desfecho === 'succeeded' || r.desfecho === 'failed');
  const maior = Math.max(...(terminados.length ? terminados : runs).map((r) => r.duracaoMs), 1);
  const larguraBarra = 14;
  const vao = 2; // o espaçador de 2px entre marcas
  const alturaPlot = 64;
  const alturaGlifo = 14;
  const largura = runs.length * (larguraBarra + vao);

  return (
    <div style={{ marginTop: '.9rem' }}>
      <div style={{ ...s.linha, justifyContent: 'space-between' }}>
        <span style={s.dadoRotulo}>duração por run</span>
        <span style={s.fraco}>
          maior terminado: {duracao(maior)} · {runs.length} run(s)
        </span>
      </div>

      <div style={{ overflowX: 'auto', marginTop: '.3rem' }}>
        <svg
          width={Math.max(largura, 1)}
          height={alturaPlot + alturaGlifo}
          role="img"
          aria-label={`Duração dos últimos ${runs.length} runs de ${fluxo.rotulo}`}
          style={{ display: 'block' }}
        >
          <defs>
            {/* Hachura a 45°: o alívio para quem não distingue o vermelho. */}
            <pattern id={`falha-${fluxo.flowKey}`} width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
              <rect width="6" height="6" fill={cor.ruim} />
              <line x1="0" y1="0" x2="0" y2="6" stroke="#FFFFFF" strokeWidth="2" opacity="0.55" />
            </pattern>
          </defs>

          {/* Linha de base recessiva. Não há grade: seria ruído nesta escala. */}
          <line x1="0" y1={alturaPlot + alturaGlifo - 0.5} x2={largura} y2={alturaPlot + alturaGlifo - 0.5}
                stroke={cor.borda} strokeWidth="1" />

          {runs.map((r, i) => {
            const foraDaEscala = r.duracaoMs > maior;
            const h = foraDaEscala
              ? alturaPlot
              : Math.max((r.duracaoMs / maior) * alturaPlot, 3);
            const x = i * (larguraBarra + vao);
            const y = alturaPlot + alturaGlifo - h;
            const preenchimento =
              r.desfecho === 'failed' ? `url(#falha-${fluxo.flowKey})` : TOM_DO_DESFECHO[r.desfecho];
            return (
              <g key={r.chave} onMouseEnter={() => setSobre(i)} onMouseLeave={() => setSobre(null)}>
                {/* Alvo de hover maior que a marca. */}
                <rect x={x} y={0} width={larguraBarra + vao} height={alturaPlot + alturaGlifo} fill="transparent" />
                <rect x={x} y={y} width={larguraBarra} height={h} rx={4} ry={4} fill={preenchimento} />
                <text
                  x={x + larguraBarra / 2}
                  y={y - 3}
                  textAnchor="middle"
                  fontSize="10"
                  fill={TOM_DO_DESFECHO[r.desfecho]}
                  aria-hidden="true"
                >
                  {GLIFO[r.desfecho]}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {sobre !== null && runs[sobre] && (
        <div style={{ ...s.blocoTecnico, marginTop: '.3rem' }}>
          {`${NOME_DO_DESFECHO[runs[sobre].desfecho]} · ${duracao(runs[sobre].duracaoMs)} · ${quando(runs[sobre].inicioEm)}`}
          {runs[sobre].lotes && ` · lotes ${runs[sobre].lotes!.feitos}/${runs[sobre].lotes!.total}`}
          {`\n${runs[sobre].chave}`}
        </div>
      )}

      {/* Legenda: identidade nunca fica só na cor. */}
      <div style={{ ...s.linha, gap: '.9rem', marginTop: '.4rem' }}>
        {(['succeeded', 'failed', 'executing', 'preso'] as const).map((d) => (
          <span key={d} style={{ ...s.fraco, display: 'inline-flex', alignItems: 'center', gap: '.3rem' }}>
            <span style={{ color: TOM_DO_DESFECHO[d] }} aria-hidden="true">{GLIFO[d]}</span>
            {NOME_DO_DESFECHO[d]}
          </span>
        ))}
      </div>

      {!fluxo.historicoSuficiente && (
        <p style={{ ...s.fraco, marginTop: '.3rem' }}>
          Ainda acumulando: {runs.length} de {fluxo.minimoParaGrafico} runs para o gráfico mostrar
          tendência. O histórico começou a ser gravado agora e não existe retroativamente.
        </p>
      )}
    </div>
  );
}
