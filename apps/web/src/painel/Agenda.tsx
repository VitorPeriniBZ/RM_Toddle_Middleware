import { useEffect, useState } from 'react';
import { api, ApiError, type FluxoNaTela, type Painel, type PreviaDeCron } from '../api';
import { cor, desde, quando, s } from '../estilos';

/**
 * O PAINEL: desejado × observado, e os controles.
 *
 * ─── POR QUE AS DUAS COLUNAS SÃO O CORAÇÃO DESTA TELA ───────────────────────
 *
 * "Desejado" é a tabela `flow_schedule`; "observado" é o que o Redis tem de fato
 * registrado. Se o Redis reiniciar sem persistência, o scheduler desaparece e
 * NADA dá erro: o worker segue de pé consumindo uma fila que nunca mais recebe
 * nada, e a descoberta vem dias depois pela ausência de dado no Toddle.
 *
 * Uma tela que mostrasse só o horário configurado seria mais uma superfície
 * capaz de mentir sobre isso. Esta existe para acusar a divergência.
 *
 * ─── PRESET ANTES DE CRON LIVRE ─────────────────────────────────────────────
 *
 * Noventa por cento do uso real é escolher um horário. Campo de cron livre é
 * onde mora o `* * * * *` digitado por engano — e com `concurrency: 1` o sintoma
 * não seria paralelismo, seria backlog crescente, que aparece horas depois longe
 * da causa. O campo avançado existe, escondido, e o servidor recusa intervalo
 * abaixo do mínimo de qualquer forma.
 */

const PRESETS: Array<{ rotulo: string; cron: string }> = [
  { rotulo: 'Toda noite às 3h', cron: '0 3 * * *' },
  { rotulo: '4× ao dia (3h, 9h, 12h, 16h)', cron: '0 3,9,12,16 * * *' },
  { rotulo: 'A cada 30 min, 6h–22h', cron: '*/30 6-22 * * *' },
  { rotulo: 'De hora em hora, 6h–22h', cron: '0 6-22 * * *' },
];

export function Agenda({ aoErrar }: { aoErrar: (e: unknown) => void }) {
  const [painel, setPainel] = useState<Painel | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [editando, setEditando] = useState<string | null>(null);

  async function carregar(): Promise<void> {
    setCarregando(true);
    try {
      setPainel(await api.painel());
    } catch (e) {
      aoErrar(e);
    } finally {
      setCarregando(false);
    }
  }

  useEffect(() => { void carregar(); }, []);

  if (!painel) return <p style={s.fraco}>{carregando ? 'Lendo a agenda…' : '—'}</p>;

  return (
    <>
      <div style={{ ...s.linha, justifyContent: 'space-between', marginTop: '1rem' }}>
        <h2 style={{ ...s.h2, marginTop: 0 }}>Agenda</h2>
        <button style={s.botao} onClick={() => void carregar()} disabled={carregando}>
          {carregando ? 'Atualizando…' : 'Atualizar'}
        </button>
      </div>

      {painel.fluxos.map((f) => (
        <CartaoDoFluxo
          key={f.flowKey}
          fluxo={f}
          editando={editando === f.flowKey}
          aoEditar={(sim) => setEditando(sim ? f.flowKey : null)}
          aoMudar={() => void carregar()}
          aoErrar={aoErrar}
        />
      ))}

      {painel.orfaos.length > 0 && (
        <div style={s.aviso('atencao')}>
          <strong>{painel.orfaos.length} scheduler(s) órfão(s) no Redis.</strong> Id que não pertence a
          nenhum fluxo — ele dispara sem aparecer em configuração alguma. A próxima reconciliação do
          worker remove.
          <ul style={{ margin: '.4rem 0 0', paddingLeft: '1.2rem' }}>
            {painel.orfaos.map((o) => (
              <li key={o.id} style={s.mono}>{o.id} · {o.fila} · {o.cron}</li>
            ))}
          </ul>
        </div>
      )}

      <h2 style={s.h2}>Fila de jobs mortos (DLQ)</h2>
      <div style={painel.dlq.total > 0 ? s.aviso('ruim') : s.aviso('bom')}>
        <strong>{painel.dlq.total}</strong> registro(s).
        {painel.dlq.total > 0 && (
          <>
            {' '}Nada consome esta fila — eles ficam aqui até alguém reprocessar com{' '}
            <code style={s.mono}>npm run dlq</code>.
            <ul style={{ margin: '.4rem 0 0', paddingLeft: '1.2rem' }}>
              {painel.dlq.recentes.map((r, i) => (
                <li key={r.jobId ?? i} style={{ fontSize: '.85rem' }}>
                  <span style={s.mono}>{r.jobName}</span> · {quando(r.failedAt)} · {r.failedReason.slice(0, 140)}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  );
}

function CartaoDoFluxo({
  fluxo, editando, aoEditar, aoMudar, aoErrar,
}: {
  fluxo: FluxoNaTela;
  editando: boolean;
  aoEditar: (sim: boolean) => void;
  aoMudar: () => void;
  aoErrar: (e: unknown) => void;
}) {
  const d = fluxo.desejado;
  const ligado = Boolean(d?.ativo);

  return (
    <div style={s.cartao}>
      <div style={{ ...s.linha, justifyContent: 'space-between' }}>
        <div style={s.linha}>
          <h3 style={s.h3}>{fluxo.rotulo}</h3>
          <span style={s.selo(ligado ? 'bom' : 'neutro')}>{ligado ? 'ligado' : 'desligado'}</span>
          {!fluxo.podeAtivar && <span style={s.selo('atencao')}>bloqueado</span>}
          {fluxo.divergencias.length > 0 && <span style={s.selo('ruim')}>divergente</span>}
        </div>
        <div style={s.linha}>
          <BotaoDeChave fluxo={fluxo} aoMudar={aoMudar} aoErrar={aoErrar} />
          <button style={s.botao} onClick={() => aoEditar(!editando)}>
            {editando ? 'Fechar' : 'Horário'}
          </button>
        </div>
      </div>

      <table style={{ ...s.tabela, marginTop: '.6rem' }}>
        <tbody>
          <tr>
            <td style={{ ...s.td, ...s.fraco, width: 130 }}>desejado</td>
            <td style={s.td}>
              {d ? (
                <>
                  <span style={s.mono}>{d.cron}</span> <span style={s.fraco}>({d.timezone}, rev {d.revisao})</span>
                </>
              ) : (
                <span style={{ color: cor.atencao }}>
                  sem linha na agenda = desligado. Rode <code style={s.mono}>npm run schedule</code> para semear.
                </span>
              )}
            </td>
          </tr>
          <tr>
            <td style={{ ...s.td, ...s.fraco }}>observado</td>
            <td style={s.td}>
              {fluxo.observado ? (
                <>
                  <span style={s.mono}>{fluxo.observado.cron}</span>{' '}
                  <span style={s.fraco}>
                    próximo {quando(fluxo.observado.proximoDisparoEm)} · {fluxo.observado.iteracoes ?? 0} disparos
                  </span>
                </>
              ) : (
                <span style={{ color: ligado ? cor.ruim : cor.fraco }}>nada registrado no Redis</span>
              )}
            </td>
          </tr>
          <tr>
            <td style={{ ...s.td, ...s.fraco }}>último run</td>
            <td style={s.td}>
              {fluxo.ultimoRun ? (
                <>
                  <span style={s.selo(
                    fluxo.ultimoRun.estado === 'succeeded' ? 'bom'
                      : fluxo.ultimoRun.estado === 'failed' ? 'ruim' : 'atencao',
                  )}>
                    {fluxo.ultimoRun.estado}
                  </span>{' '}
                  {quando(fluxo.ultimoRun.atualizadoEm)}{' '}
                  <span style={s.mono}>{JSON.stringify(fluxo.ultimoRun.resultado)}</span>
                </>
              ) : (
                <span style={s.fraco}>nenhum registrado em job_run</span>
              )}
            </td>
          </tr>
          <tr>
            <td style={{ ...s.td, ...s.fraco }}>último sucesso</td>
            <td style={s.td}>
              {/* A pergunta que importa não é "rodou?", é "há quanto tempo dá certo?".
                  Um fluxo que falha de hora em hora tem último run recentíssimo. */}
              <span style={{ color: fluxo.ultimoSucessoEm ? cor.texto : cor.atencao }}>
                {desde(fluxo.ultimoSucessoEm)}
              </span>{' '}
              <span style={s.fraco}>(o vigia alerta depois de {fluxo.janelaSemSucessoHoras}h)</span>
            </td>
          </tr>
          {d?.ativo && fluxo.proximosDisparos.length > 0 && (
            <tr>
              <td style={{ ...s.td, ...s.fraco }}>próximos</td>
              <td style={{ ...s.td, ...s.mono }}>{fluxo.proximosDisparos.map((p) => p.slice(0, 16)).join('  ·  ')}</td>
            </tr>
          )}
        </tbody>
      </table>

      {fluxo.divergencias.map((div) => (
        <div key={div} style={s.aviso('ruim')}>{div}</div>
      ))}

      {!fluxo.podeAtivar && fluxo.motivoDoBloqueio && (
        <div style={s.aviso('atencao')}>
          <strong>Não pode ser ligado.</strong> {fluxo.motivoDoBloqueio}
        </div>
      )}

      {editando && <EditorDeHorario fluxo={fluxo} aoMudar={aoMudar} aoErrar={aoErrar} />}
    </div>
  );
}

/** Liga/desliga. Pede motivo, porque a auditoria guarda o motivo. */
function BotaoDeChave({
  fluxo, aoMudar, aoErrar,
}: { fluxo: FluxoNaTela; aoMudar: () => void; aoErrar: (e: unknown) => void }) {
  const [salvando, setSalvando] = useState(false);
  const ligado = Boolean(fluxo.desejado?.ativo);

  async function virar(): Promise<void> {
    const motivo = window.prompt(
      `${ligado ? 'Desligar' : 'Ligar'} "${fluxo.rotulo}". Por quê? (fica na auditoria)`,
      '',
    );
    if (motivo === null) return; // cancelou
    setSalvando(true);
    try {
      await api.salvarAgenda(fluxo.flowKey, { ativo: !ligado, motivo: motivo || undefined });
      aoMudar();
    } catch (e) {
      aoErrar(e);
    } finally {
      setSalvando(false);
    }
  }

  const impedido = !ligado && !fluxo.podeAtivar;
  return (
    <button
      style={{ ...s.botao, opacity: impedido ? 0.5 : 1 }}
      onClick={() => void virar()}
      disabled={salvando || impedido || !fluxo.desejado}
      title={impedido ? fluxo.motivoDoBloqueio ?? '' : ''}
    >
      {salvando ? '…' : ligado ? 'Desligar' : 'Ligar'}
    </button>
  );
}

/**
 * Editor de horário: preset, prévia e só então salvar.
 *
 * A prévia vem do SERVIDOR. O usuário confirma o que vê, não o que digitou — a
 * mesma expressão significa horários diferentes em fusos diferentes, e uma prévia
 * calculada aqui usaria o fuso do navegador de quem olha, que não é
 * necessariamente o fuso em que o job roda.
 */
function EditorDeHorario({
  fluxo, aoMudar, aoErrar,
}: { fluxo: FluxoNaTela; aoMudar: () => void; aoErrar: (e: unknown) => void }) {
  const [cron, setCron] = useState(fluxo.desejado?.cron ?? '0 3 * * *');
  const [avancado, setAvancado] = useState(false);
  const [previa, setPrevia] = useState<PreviaDeCron | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  async function verPrevia(alvo = cron): Promise<void> {
    setOcupado(true);
    setErro(null);
    setPrevia(null);
    try {
      setPrevia(await api.previa(fluxo.flowKey, alvo));
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : String(e));
    } finally {
      setOcupado(false);
    }
  }

  async function salvar(): Promise<void> {
    const motivo = window.prompt(`Mudar o horário de "${fluxo.rotulo}" para "${cron}". Por quê?`, '');
    if (motivo === null) return;
    setOcupado(true);
    setErro(null);
    try {
      await api.salvarAgenda(fluxo.flowKey, { cron, motivo: motivo || undefined });
      aoMudar();
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : String(e));
      aoErrar(e);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div style={{ marginTop: '.8rem', paddingTop: '.8rem', borderTop: `1px solid ${cor.borda}` }}>
      <div style={{ ...s.linha, gap: '.35rem' }}>
        {PRESETS.map((p) => (
          <button
            key={p.cron}
            style={{ ...s.botao, fontWeight: cron === p.cron ? 600 : 400 }}
            onClick={() => { setCron(p.cron); void verPrevia(p.cron); }}
          >
            {p.rotulo}
          </button>
        ))}
        <button style={{ ...s.botao, ...s.fraco }} onClick={() => setAvancado(!avancado)}>
          {avancado ? 'esconder cron' : 'cron…'}
        </button>
      </div>

      {avancado && (
        <div style={{ ...s.linha, marginTop: '.5rem' }}>
          <input
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            style={{ ...s.campo, width: 200 }}
            placeholder="minuto hora dia mês dia-da-semana"
          />
          <span style={s.fraco}>
            5 campos. O servidor recusa intervalo curto — cada passada custa uma leitura de Sentença no RM.
          </span>
        </div>
      )}

      <div style={{ ...s.linha, marginTop: '.6rem' }}>
        <span style={s.mono}>{cron}</span>
        <button style={s.botao} onClick={() => void verPrevia()} disabled={ocupado}>Ver prévia</button>
        <button
          style={s.botao}
          onClick={() => void salvar()}
          disabled={ocupado || !previa?.ok || previa.colide || cron === fluxo.desejado?.cron}
          title={!previa ? 'veja a prévia antes de salvar' : ''}
        >
          Salvar
        </button>
      </div>

      {erro && <div style={s.aviso('ruim')}>{erro}</div>}

      {previa?.ok && (
        <div style={previa.colide ? s.aviso('ruim') : s.aviso('bom')}>
          <div>
            Próximos disparos (America/Sao_Paulo):{' '}
            <span style={s.mono}>{previa.proximos.map((p) => p.slice(0, 16)).join('  ·  ')}</span>
          </div>
          <div style={s.fraco}>intervalo mínimo: {previa.intervaloMinimoMinutos} min</div>
          {previa.colide && <div style={{ color: cor.ruim, marginTop: '.3rem' }}>{previa.motivo}</div>}
          {previa.avisoDeFolga && <div style={{ color: cor.atencao, marginTop: '.3rem' }}>{previa.avisoDeFolga}</div>}
        </div>
      )}
    </div>
  );
}
