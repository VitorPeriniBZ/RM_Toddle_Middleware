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

/**
 * O estado de um fluxo, em UMA palavra.
 *
 * A versão anterior empilhava até quatro selos no mesmo cabeçalho (ligado +
 * bloqueado + divergente + revisão não confirmada). Quatro selos não são quatro
 * informações: são um borrão que obriga a ler tudo para saber se importa. Aqui a
 * precedência é explícita — o pior vence — e o resto desce para os detalhes.
 */
type Situacao = 'divergente' | 'bloqueado' | 'revisao' | 'ligado' | 'desligado';

function situacaoDe(f: FluxoNaTela): Situacao {
  if (f.divergencias.length > 0) return 'divergente';
  if (!f.podeAtivar) return 'bloqueado';
  if (f.revisaoPendente && f.observadoConfere) return 'revisao';
  return f.desejado?.ativo ? 'ligado' : 'desligado';
}

const TOM: Record<Situacao, 'bom' | 'ruim' | 'atencao' | 'neutro'> = {
  divergente: 'ruim',
  bloqueado: 'atencao',
  revisao: 'atencao',
  ligado: 'bom',
  desligado: 'neutro',
};

const ROTULO_SITUACAO: Record<Situacao, string> = {
  divergente: 'divergente',
  bloqueado: 'bloqueado',
  revisao: 'revisão pendente',
  ligado: 'ligado',
  desligado: 'desligado',
};

/** Algum fluxo com job em voo? Decide se a tela fica se atualizando. */
function painelTemExecucao(p: Painel | null): boolean {
  return Boolean(p?.fluxos.some((f) => f.execucaoEmVoo));
}

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

  /**
   * Enquanto houver execução em voo, recarrega sozinho.
   *
   * Sem isto o botão "Sincronizar agora" ficaria travado até alguém apertar
   * Atualizar — a trava nasceria correta e depois envelheceria, que é a mesma
   * classe de mentira que esta tela existe para não cometer. Quando nada está
   * rodando, não fica pedindo à toa.
   */
  const algoRodando = painelTemExecucao(painel);
  useEffect(() => {
    if (!algoRodando) return;
    const t = setInterval(() => void carregar(), 5_000);
    return () => clearInterval(t);
  }, [algoRodando]);

  if (!painel) return <p style={s.fraco}>{carregando ? 'Lendo a agenda…' : '—'}</p>;

  const situacoes = painel.fluxos.map(situacaoDe);
  const ligados = situacoes.filter((x) => x === 'ligado').length;
  const problemas = situacoes.filter((x) => x === 'divergente').length;
  const atencao = situacoes.filter((x) => x === 'bloqueado' || x === 'revisao').length;
  // "sem pendência" tem de significar NADA a fazer. Contar só divergência
  // deixaria o selo verde ao lado de "1 atenção" e de um fluxo bloqueado — o
  // sinal misturado que esta barra existe para acabar.
  const tudoBem =
    problemas === 0 && atencao === 0 && painel.dlq.total === 0 && painel.orfaos.length === 0;

  return (
    <>
      {/* A resposta antes da leitura. Quem abre a tela quer saber se precisa
          fazer alguma coisa — não ler quatro cartões para descobrir que não. */}
      <div style={{ ...s.barra, justifyContent: 'space-between' }}>
        <div style={s.linha}>
          <span style={s.selo(tudoBem ? 'bom' : problemas > 0 ? 'ruim' : 'atencao')}>
            {tudoBem ? 'sem pendência' : problemas > 0 ? `${problemas} divergente(s)` : 'requer atenção'}
          </span>
          <Kpi n={ligados} de={painel.fluxos.length} rotulo="ligados" tom="neutro" />
          <Kpi n={atencao} rotulo="atenção" tom={atencao > 0 ? 'atencao' : 'neutro'} />
          <Kpi n={painel.dlq.total} rotulo="na DLQ" tom={painel.dlq.total > 0 ? 'ruim' : 'neutro'} />
          <Kpi n={painel.orfaos.length} rotulo="órfãos" tom={painel.orfaos.length > 0 ? 'atencao' : 'neutro'} />
        </div>
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
          nenhum fluxo — dispara sem aparecer em configuração alguma. A próxima reconciliação do
          worker remove.
          <details>
            <summary style={s.resumoDetalhe}>ver os ids</summary>
            <div style={s.blocoTecnico}>
              {painel.orfaos.map((o) => `${o.id}  ·  ${o.fila}  ·  ${o.cron}`).join('\n')}
            </div>
          </details>
        </div>
      )}

      <h2 style={s.h2}>Fila de jobs mortos (DLQ)</h2>
      {painel.dlq.total === 0 ? (
        <p style={s.fraco}>Vazia.</p>
      ) : (
        <div style={s.aviso('ruim')}>
          <strong>{painel.dlq.total}</strong> registro(s). Nada consome esta fila — ficam aqui até
          alguém reprocessar com <code style={s.mono}>npm run dlq</code>.
          <table style={{ ...s.tabela, marginTop: '.5rem' }}>
            <thead>
              <tr><th style={s.th}>job</th><th style={s.th}>quando</th><th style={s.th}>motivo</th></tr>
            </thead>
            <tbody>
              {painel.dlq.recentes.map((r, i) => (
                <tr key={r.jobId ?? i}>
                  <td style={{ ...s.td, ...s.mono, whiteSpace: 'nowrap' }}>{r.jobName}</td>
                  <td style={{ ...s.td, whiteSpace: 'nowrap' }}>{quando(r.failedAt)}</td>
                  <td style={{ ...s.td, fontSize: '.8rem' }}>{r.failedReason.slice(0, 200)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** Número grande + rótulo. `de` mostra o total quando a fração importa. */
function Kpi({ n, de, rotulo, tom }: { n: number; de?: number; rotulo: string; tom: 'bom' | 'ruim' | 'atencao' | 'neutro' }) {
  return (
    <div>
      <div style={s.kpiNumero(tom)}>
        {n}{de !== undefined && <span style={{ fontSize: '.8rem', fontWeight: 400, color: cor.fraco }}>/{de}</span>}
      </div>
      <div style={s.kpiRotulo}>{rotulo}</div>
    </div>
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
  const situacao = situacaoDe(fluxo);
  const confere = Boolean(fluxo.observado && d && fluxo.observado.cron === d.cron);
  const [confirmando, setConfirmando] = useState(false);

  const emVoo = fluxo.execucaoEmVoo;
  const podeRodarAgora = fluxo.podeAtivar && !emVoo;
  const motivoDeNaoRodar = !fluxo.podeAtivar
    ? fluxo.motivoDoBloqueio ?? ''
    : emVoo
      ? `já há ${emVoo.quantidade} execução(ões) deste fluxo em voo${emVoo.desde ? `, desde ${desde(emVoo.desde)}` : ''}`
      : '';

  // Painel aberto e a execução começou (pelo cron, ou por outra pessoa): fecha,
  // senão sobra um botão "Confirmar e rodar" que só produziria 409.
  useEffect(() => {
    if (emVoo && confirmando) setConfirmando(false);
  }, [emVoo, confirmando]);

  return (
    <div style={s.cartao}>
      <div style={{ ...s.linha, justifyContent: 'space-between' }}>
        <div style={s.linha}>
          <h3 style={s.h3}>{fluxo.rotulo}</h3>
          <span style={s.selo(TOM[situacao])}>{ROTULO_SITUACAO[situacao]}</span>
        </div>
        <div style={s.linha}>
          <BotaoDeChave fluxo={fluxo} aoMudar={aoMudar} aoErrar={aoErrar} />
          <button style={s.botao} onClick={() => aoEditar(!editando)}>
            {editando ? 'Fechar' : 'Horário'}
          </button>
          {/* Rodar agora não depende de o fluxo estar LIGADO: desligado é sobre
              o automático, e a execução manual é justamente o caso de quem quer
              uma passada sem ligar o cron. Só fluxo BLOQUEADO não roda.

              E não roda com outra execução em voo: os workers são
              `concurrency: 1`, então o segundo job não rodaria em paralelo — ele
              esperaria e rodaria EM SEGUIDA, reescrevendo o que o primeiro
              acabou de escrever. O botão diz isso no rótulo em vez de deixar a
              pessoa clicar e receber uma recusa. */}
          <button
            style={{ ...s.botao, opacity: podeRodarAgora ? 1 : 0.5 }}
            onClick={() => setConfirmando(!confirmando)}
            disabled={!podeRodarAgora}
            title={motivoDeNaoRodar}
          >
            {confirmando ? 'Fechar' : emVoo ? 'Já está rodando' : 'Sincronizar agora'}
          </button>
        </div>
      </div>

      {/* ─── desejado × observado, lado a lado ─────────────────────────────
          Esta comparação é o motivo desta aba existir. Se o Redis reiniciar sem
          persistência o scheduler some e NADA dá erro; o worker segue de pé
          consumindo uma fila que nunca mais recebe nada. Lado a lado, a
          divergência aparece antes de alguém ler o texto. */}
      <div style={s.comparacao}>
        <div>
          <div style={s.dadoRotulo}>desejado (banco)</div>
          {d ? (
            <div style={s.mono}>{d.cron}</div>
          ) : (
            <div style={{ color: cor.atencao, fontSize: '.85rem' }}>
              sem linha na agenda = desligado
            </div>
          )}
        </div>
        <div
          style={{ fontSize: '1.1rem', color: confere ? cor.bom : fluxo.observado ? cor.ruim : cor.fraco }}
          title={confere ? 'o Redis está com este horário' : 'o Redis NÃO confere'}
        >
          {confere ? '=' : '≠'}
        </div>
        <div>
          <div style={s.dadoRotulo}>observado (Redis)</div>
          {fluxo.observado ? (
            <div style={s.mono}>{fluxo.observado.cron}</div>
          ) : (
            <div style={{ color: d?.ativo ? cor.ruim : cor.fraco, fontSize: '.85rem' }}>
              nada registrado
            </div>
          )}
        </div>
      </div>

      {/* ─── a pergunta que importa ────────────────────────────────────────
          Não é "rodou?", é "há quanto tempo dá certo?". Um fluxo que falha de
          hora em hora tem último run recentíssimo — por isso o último SUCESSO
          vem primeiro e sozinho. */}
      <div style={s.tira}>
        <span>
          <span style={s.dadoRotulo}>último sucesso </span>
          <strong style={{ color: fluxo.ultimoSucessoEm ? cor.texto : cor.atencao }}>
            {desde(fluxo.ultimoSucessoEm)}
          </strong>
          <span style={s.fraco}> (alerta em {fluxo.janelaSemSucessoHoras}h)</span>
        </span>
        {fluxo.observado?.proximoDisparoEm && (
          <span>
            <span style={s.dadoRotulo}>próximo </span>
            {quando(fluxo.observado.proximoDisparoEm)}
          </span>
        )}
        {fluxo.ultimoRun && (
          <span>
            <span style={s.dadoRotulo}>último run </span>
            <span style={s.selo(
              fluxo.ultimoRun.estado === 'succeeded' ? 'bom'
                : fluxo.ultimoRun.estado === 'failed' ? 'ruim' : 'atencao',
            )}>
              {fluxo.ultimoRun.estado}
            </span>{' '}
            {quando(fluxo.ultimoRun.atualizadoEm)}
          </span>
        )}
      </div>

      {/* Divergência é o único aviso que fica sempre aberto: é a razão do selo
          vermelho, e esconder a explicação do vermelho faz o vermelho virar
          enfeite. */}
      {fluxo.divergencias.map((div) => (
        <div key={div} style={s.aviso('ruim')}>{div}</div>
      ))}

      {/* Revisão pendente com o Redis JÁ conferindo não é divergência: é quase
          sempre "nenhum worker de pé para confirmar". Tom neutro, porque
          vermelho em cima do estado correto ensina a ignorar o vermelho. */}
      {fluxo.revisaoPendente && fluxo.observadoConfere && (
        <div style={s.aviso('atencao')}>
          Revisão {d?.revisao} ainda não confirmada por um worker — mas o Redis já está com este
          horário. Some quando o worker passar (boot, aviso ou o poll de 60s).
        </div>
      )}

      {!fluxo.podeAtivar && fluxo.motivoDoBloqueio && (
        <div style={s.aviso('atencao')}>
          <strong>Não pode ser ligado.</strong> {fluxo.motivoDoBloqueio}
        </div>
      )}

      {/* O resto é verdade, e quase nunca é a pergunta. Fica a um clique. */}
      <details>
        <summary style={s.resumoDetalhe}>detalhes técnicos</summary>
        <div style={s.tira}>
          <span><span style={s.dadoRotulo}>flowKey </span><code style={s.mono}>{fluxo.flowKey}</code></span>
          {d && <span><span style={s.dadoRotulo}>fuso </span>{d.timezone}</span>}
          {d && <span><span style={s.dadoRotulo}>revisão </span>{d.revisao}</span>}
          {fluxo.observado && (
            <span><span style={s.dadoRotulo}>disparos </span>{fluxo.observado.iteracoes ?? 0}</span>
          )}
        </div>
        {!d && (
          <div style={{ ...s.fraco, marginTop: '.4rem' }}>
            Rode <code style={s.mono}>npm run schedule</code> para semear a linha na agenda.
          </div>
        )}
        {d?.ativo && fluxo.proximosDisparos.length > 0 && (
          <>
            <div style={{ ...s.dadoRotulo, marginTop: '.5rem' }}>próximos disparos</div>
            <div style={s.blocoTecnico}>
              {fluxo.proximosDisparos.map((x) => x.slice(0, 16)).join('\n')}
            </div>
          </>
        )}
        {fluxo.ultimoRun && (
          <>
            <div style={{ ...s.dadoRotulo, marginTop: '.5rem' }}>resultado do último run</div>
            <div style={s.blocoTecnico}>{JSON.stringify(fluxo.ultimoRun.resultado, null, 2)}</div>
          </>
        )}
        {!fluxo.ultimoRun && (
          <div style={{ ...s.fraco, marginTop: '.4rem' }}>nenhum run registrado em <code style={s.mono}>job_run</code>.</div>
        )}
      </details>

      {emVoo && (
        <div style={s.aviso('atencao')}>
          <strong>Execução em curso.</strong> {emVoo.quantidade} job(s) deste fluxo na fila
          {emVoo.desde && ` desde ${desde(emVoo.desde)}`}. Rodar de novo agora não faria os dois em
          paralelo — os workers processam um de cada vez, então o segundo esperaria e reescreveria o
          que o primeiro acabou de escrever. Acompanhe na aba Jobs.
        </div>
      )}

      {confirmando && (
        <ConfirmacaoDeExecucao
          fluxo={fluxo}
          aoFechar={() => setConfirmando(false)}
          aoMudar={aoMudar}
          aoErrar={aoErrar}
        />
      )}

      {editando && <EditorDeHorario fluxo={fluxo} aoMudar={aoMudar} aoErrar={aoErrar} />}
    </div>
  );
}

/**
 * A confirmação de "Sincronizar agora".
 *
 * ─── POR QUE NÃO É UM `window.confirm` ──────────────────────────────────────
 *
 * Porque um "tem certeza?" não é confirmação: é um clique a mais, e a pessoa
 * aprende a dar no automático. O que faz alguém parar é LER o que vai acontecer
 * — e isso é diferente por fluxo. Criar staff no Toddle é irreversível; escrever
 * nota mexe no registro acadêmico; sincronizar aluno não apaga ninguém.
 *
 * O texto vem do catálogo de fluxos (`avisoAoExecutarAgora`), não daqui: o
 * efeito de rodar é propriedade do fluxo. Se o destino do job mudar e o aviso
 * morasse na tela, a tela mentiria — que foi exatamente o que aconteceu com a
 * via de nota, que passou meses apontando para um DataServer que descartava o
 * valor.
 *
 * ─── O MOTIVO É OPCIONAL, MAS VAI PARA A AUDITORIA ─────────────────────────
 *
 * Mesma escolha do liga/desliga: `audit_event` guarda quem mandou rodar e por
 * quê. Exigir o motivo faria a pessoa digitar "teste" para passar da tela.
 */
function ConfirmacaoDeExecucao({
  fluxo, aoFechar, aoMudar, aoErrar,
}: {
  fluxo: FluxoNaTela;
  aoFechar: () => void;
  aoMudar: () => void;
  aoErrar: (e: unknown) => void;
}) {
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function confirmar(): Promise<void> {
    setEnviando(true);
    setErro(null);
    try {
      const r = await api.executarAgora(fluxo.flowKey, motivo.trim() || undefined);
      setOk(r.aplicacao);
      aoMudar();
    } catch (e) {
      // 409 (já há job na fila, ou fluxo bloqueado) é resposta, não falha da
      // tela: fica aqui dentro, ao lado do botão que a provocou.
      if (e instanceof ApiError && e.status === 409) {
        const corpo = e.corpo as { erro?: string; comoResolver?: string; motivo?: string } | null;
        setErro([corpo?.erro, corpo?.comoResolver ?? corpo?.motivo].filter(Boolean).join(' — '));
      } else {
        setErro(e instanceof Error ? e.message : String(e));
        aoErrar(e);
      }
    } finally {
      setEnviando(false);
    }
  }

  if (ok) {
    return (
      <div style={s.aviso('bom')}>
        <strong>Enfileirado.</strong> {ok}
        <div style={{ marginTop: '.5rem' }}>
          <button style={s.botao} onClick={aoFechar}>Fechar</button>
        </div>
      </div>
    );
  }

  return (
    <div style={s.aviso('atencao')}>
      <strong>Rodar “{fluxo.rotulo}” agora, fora do horário.</strong>
      <p style={{ margin: '.45rem 0 0' }}>{fluxo.avisoAoExecutarAgora}</p>
      <div style={{ ...s.linha, marginTop: '.6rem' }}>
        <input
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder="motivo (opcional, fica na auditoria)"
          style={{ ...s.campo, fontFamily: 'inherit', width: 320 }}
          disabled={enviando}
        />
        <button style={s.botao} onClick={() => void confirmar()} disabled={enviando}>
          {enviando ? 'Enfileirando…' : 'Confirmar e rodar'}
        </button>
        <button style={s.botao} onClick={aoFechar} disabled={enviando}>Cancelar</button>
      </div>
      {erro && <div style={{ color: cor.ruim, marginTop: '.5rem' }}>{erro}</div>}
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
