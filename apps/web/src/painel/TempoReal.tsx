import { useEffect, useState } from 'react';
import { api, ApiError, type DetectorNaTela, type EstadoDaCota, type PainelContinuo, type SituacaoDoDetector } from '../api';
import { cor, haQuanto, intervaloLegivel, quando, s, textoLimpo } from '../estilos';

/**
 * TEMPO QUASE REAL — os detectores de mudança, na aba Agenda.
 *
 * ─── O QUE ESTA SEÇÃO RESPONDE ──────────────────────────────────────────────
 *
 * "Se eu lançar uma nota agora, quanto tempo até ela estar no TOTVS?" Com um
 * detector ligado, 1–2 minutos; desligado, o próximo horário da agenda. A
 * seção mostra qual dos dois vale, e PROVA com a última olhada — "ligado"
 * sem "olhou há 20 s" ao lado é só intenção.
 *
 * ─── POR QUE A ÚLTIMA OLHADA ANDA DE SEGUNDO EM SEGUNDO ─────────────────────
 *
 * O dado vem do servidor a cada 10 s, mas o "há N s" é recalculado aqui a cada
 * segundo, corrigido pelo relógio do servidor. Um contador que pula de 0 a 10
 * de uma vez parece travado; um que anda e de repente para é exatamente o
 * sinal de detector parado que se quer que alguém perceba.
 */

const TOM: Record<SituacaoDoDetector, 'bom' | 'ruim' | 'atencao' | 'neutro'> = {
  ativo: 'bom',
  'com-erro': 'ruim',
  parado: 'ruim',
  pausado: 'atencao',
  'sem-linha': 'atencao',
  'fora-do-horario': 'neutro',
  desligado: 'neutro',
};

const ROTULO: Record<SituacaoDoDetector, string> = {
  ativo: 'ao vivo',
  'com-erro': 'com erro',
  parado: 'parado',
  pausado: 'pausado',
  'sem-linha': 'aguardando worker',
  'fora-do-horario': 'fora do horário',
  desligado: 'desligado',
};

const COR_DO_TOM = { bom: cor.bom, ruim: cor.ruim, atencao: cor.atencao, neutro: cor.borda } as const;

/** Como a tela descreve o que aconteceu com o pedido de cada fluxo. */
const DESFECHO: Record<string, { texto: string; tom: 'bom' | 'atencao' | 'neutro' }> = {
  enfileirado: { texto: 'enviado para a fila', tom: 'bom' },
  'ja-na-fila': { texto: 'já havia uma passada esperando', tom: 'neutro' },
  'fluxo-desligado': { texto: 'não rodou: fluxo desligado na agenda', tom: 'atencao' },
  'fluxo-bloqueado': { texto: 'não rodou: fluxo bloqueado', tom: 'atencao' },
};

const INTERVALOS = [30, 60, 120, 300, 600, 900, 1800, 3600];

export function TempoReal({ aoErrar }: { aoErrar: (e: unknown) => void }) {
  const [painel, setPainel] = useState<PainelContinuo | null>(null);
  const [erroDeLeitura, setErroDeLeitura] = useState<string | null>(null);
  // Diferença entre o relógio do servidor e o deste navegador. Sem ela, um
  // computador cinco minutos adiantado veria todo detector "parado".
  const [desvio, setDesvio] = useState(0);
  const [agora, setAgora] = useState(Date.now());

  async function carregar(): Promise<void> {
    try {
      const p = await api.continuo();
      setDesvio(new Date(p.agora).getTime() - Date.now());
      setPainel(p);
      setErroDeLeitura(null);
    } catch (e) {
      // 404 = API de uma versão sem esta rota (deploy em curso). Não é falha
      // da tela; diz o que é em vez de acender o erro global.
      if (e instanceof ApiError && e.status === 404) {
        setErroDeLeitura('A API em produção ainda não tem esta seção — falta o deploy desta versão.');
      } else {
        aoErrar(e);
      }
    }
  }

  useEffect(() => {
    void carregar();
    const dados = setInterval(() => {
      if (document.visibilityState === 'visible') void carregar();
    }, 10_000);
    const relogio = setInterval(() => setAgora(Date.now()), 1_000);
    return () => {
      clearInterval(dados);
      clearInterval(relogio);
    };
  }, []);

  const agoraNoServidor = agora + desvio;
  const ligados = painel?.detectores.filter((d) => d.linha?.ativo).length ?? 0;

  return (
    <section style={{ marginTop: '1.4rem' }}>
      <div style={{ ...s.linha, justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <h2 style={{ ...s.h2, margin: 0 }}>Tempo quase real</h2>
          <div style={s.fraco}>
            Pergunta a cada minuto se algo mudou e, quando mudou, roda o fluxo na hora — sem esperar o
            horário da agenda.{' '}
            {painel && <strong style={{ color: cor.texto }}>{ligados} de {painel.detectores.length} ligados.</strong>}
          </div>
        </div>
        {painel && <MedidorDaCota cota={painel.cota} />}
      </div>

      {erroDeLeitura && <div style={s.aviso('atencao')}>{erroDeLeitura}</div>}
      {painel?.travaDoRm && (
        <AvisoDaTrava
          trava={painel.travaDoRm}
          chave={painel.detectores[0]?.chave}
          aoMudar={() => void carregar()}
          aoErrar={aoErrar}
        />
      )}
      {!painel && !erroDeLeitura && <p style={s.fraco}>Lendo os detectores…</p>}

      {painel && (
        <div className="eav-grade-detectores">
          {painel.detectores.map((d) => (
            <CartaoDoDetector
              key={d.chave}
              detector={d}
              agoraMs={agoraNoServidor}
              aoMudar={() => void carregar()}
              aoErrar={aoErrar}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * A cota do Toddle, que é o recurso que o tempo quase real mais pressiona: 250
 * chamadas a cada 5 minutos para a escola inteira, e um 429 cala tudo por 5
 * minutos. Barra de USO, não de saldo — cheio é o que se quer ver como alerta.
 */
function MedidorDaCota({ cota }: { cota: EstadoDaCota | null }) {
  if (!cota) return <span style={s.fraco}>cota do Toddle: sem leitura</span>;
  if (!cota.ativo) return <span style={s.fraco}>limitador do Toddle desligado</span>;
  const usadas = cota.capacidade - cota.disponiveis;
  const fracao = Math.min(Math.max(usadas / cota.capacidade, 0), 1);
  const tom = cota.cooldownSegundos > 0 || fracao > 0.85 ? cor.ruim : fracao > 0.6 ? cor.atencao : cor.bom;
  return (
    <div style={{ minWidth: 220 }} title="Estimativa do balde compartilhado (limitadorDeTaxa.ts). Todos os fluxos gastam desta mesma cota.">
      <div style={{ ...s.linha, justifyContent: 'space-between', gap: '.4rem' }}>
        <span style={s.dadoRotulo}>cota do Toddle</span>
        <span style={{ fontSize: '.8rem' }}>
          <strong>{usadas}</strong>
          <span style={s.fraco}> / {cota.capacidade} em {Math.round(cota.janelaSegundos / 60)} min</span>
        </span>
      </div>
      <div style={{ height: 6, background: cor.fundoFraco, border: `1px solid ${cor.borda}`, marginTop: '.2rem' }}>
        <div style={{ width: `${Math.round(fracao * 100)}%`, height: '100%', background: tom, transition: 'width .4s' }} />
      </div>
      {cota.cooldownSegundos > 0 && (
        <div style={{ color: cor.ruim, fontSize: '.78rem', marginTop: '.2rem' }}>
          Toddle recusou por excesso: tudo parado por mais {Math.ceil(cota.cooldownSegundos / 60)} min
        </div>
      )}
    </div>
  );
}

function CartaoDoDetector({
  detector: d, agoraMs, aoMudar, aoErrar,
}: {
  detector: DetectorNaTela;
  agoraMs: number;
  aoMudar: () => void;
  aoErrar: (e: unknown) => void;
}) {
  const [painelAberto, setPainelAberto] = useState<'ligar' | 'desligar' | 'ajustar' | null>(null);
  const l = d.linha;
  const tom = TOM[d.situacao];
  const contadores = l?.contadores ?? {};
  const contadoresDeHoje = contadores.dia && l && contadores.dia === diaLocal(agoraMs) ? contadores : {};
  const nenhumFluxoLigado = d.fluxos.every((f) => !f.ligado);

  return (
    <div
      style={{
        ...s.cartao,
        marginTop: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: '.55rem',
        borderTop: `3px solid ${COR_DO_TOM[tom]}`,
      }}
    >
      <div style={{ ...s.linha, justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={s.dadoRotulo}>{d.direcao}</div>
          <h3 style={{ ...s.h3, fontSize: '1.05rem' }}>{d.rotulo}</h3>
        </div>
        <span style={{ ...s.selo(tom), display: 'inline-flex', alignItems: 'center', gap: '.35rem' }}>
          <span className={`eav-pulso${d.situacao === 'ativo' ? ' vivo' : ''}`} aria-hidden="true" />
          {ROTULO[d.situacao]}
        </span>
      </div>

      <div style={s.fraco}>
        {l ? (
          <>a cada <strong style={{ color: cor.texto }}>{intervaloLegivel(l.intervaloSegundos)}</strong> · {d.janela}</>
        ) : (
          <>padrão: a cada {intervaloLegivel(d.padrao.intervaloSegundos)}</>
        )}
      </div>

      {/* A prova de vida, primeiro e grande. */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.4rem .8rem' }}>
        <Dado rotulo="última olhada" valor={haQuanto(l?.ultimaSondagemEm, agoraMs)} forte={d.situacao === 'ativo'} />
        <Dado
          rotulo="última mudança"
          valor={l?.ultimaMudancaEm ? haQuanto(l.ultimaMudancaEm, agoraMs) : 'nenhuma ainda'}
          dica={l?.ultimaMudancaEm ? quando(l.ultimaMudancaEm) : undefined}
        />
      </div>

      {l?.ultimoDisparo && (
        <div style={{ fontSize: '.84rem', borderLeft: `2px solid ${cor.borda}`, paddingLeft: '.55rem' }}>
          <div>{l.ultimoDisparo.resumo}</div>
          {Object.entries(l.ultimoDisparo.desfechos).map(([fluxo, desfecho]) => {
            const x = DESFECHO[desfecho] ?? { texto: desfecho, tom: 'neutro' as const };
            const rotulo = d.fluxos.find((f) => f.key === fluxo)?.rotulo ?? fluxo;
            return (
              <div key={fluxo} style={{ ...s.fraco, fontSize: '.78rem' }}>
                → {rotulo.replace(/\s*\(.*\)$/, '')}:{' '}
                <span style={{ color: x.tom === 'bom' ? cor.bomTexto : x.tom === 'atencao' ? cor.atencao : cor.fraco }}>
                  {x.texto}
                  {desfecho === 'enfileirado' && l.ultimoDisparo?.inicios?.[fluxo] &&
                    Date.parse(l.ultimoDisparo.inicios[fluxo]) > agoraMs + 20_000 &&
                    ` — começa ${quando(l.ultimoDisparo.inicios[fluxo])}`}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {l && (
        <div style={{ ...s.fraco, fontSize: '.78rem' }}>
          hoje: {plural(contadoresDeHoje.sondagens ?? 0, 'olhada', 'olhadas')} ·{' '}
          {plural(contadoresDeHoje.mudancas ?? 0, 'mudança', 'mudanças')} ·{' '}
          {plural(contadoresDeHoje.disparos ?? 0, 'passada disparada', 'passadas disparadas')}
        </div>
      )}

      <div style={{ ...s.linha, gap: '.3rem' }}>
        <span style={{ ...s.dadoRotulo, marginRight: '.1rem' }}>dispara</span>
        {d.fluxos.map((f) => (
          <span
            key={f.key}
            style={s.selo(f.ligado ? 'bom' : 'neutro')}
            title={f.ligado ? 'ligado na agenda' : 'desligado na agenda — o detector não o roda'}
          >
            {f.rotulo.replace(/\s*\(.*\)$/, '')}
          </span>
        ))}
      </div>

      {d.situacao !== 'ativo' && d.situacao !== 'desligado' && (
        <div style={{ ...s.aviso(tom === 'ruim' ? 'ruim' : 'atencao'), marginTop: 0 }}>{textoLimpo(d.explicacao)}</div>
      )}
      {l?.ultimoErro && d.situacao !== 'pausado' && (
        <div style={{ ...s.aviso('ruim'), marginTop: 0, fontSize: '.8rem' }}>
          <strong>Último erro</strong> ({haQuanto(l.ultimoErroEm, agoraMs)}): {textoLimpo(l.ultimoErro).slice(0, 260)}
        </div>
      )}

      <div style={{ ...s.linha, gap: '.35rem', marginTop: 'auto' }}>
        {l?.ativo ? (
          <button style={s.botao} onClick={() => setPainelAberto(painelAberto === 'desligar' ? null : 'desligar')}>
            Desligar
          </button>
        ) : (
          <button
            // Contorno no verde da marca e TEXTO no verde-floresta: nem branco
            // sobre oliva (2,6:1) nem o #408F38 em letra de 14px (4,0:1) passam AA.
            style={{ ...s.botao, fontWeight: 600, color: cor.bomTexto, borderColor: cor.bom, opacity: nenhumFluxoLigado ? 0.5 : 1 }}
            onClick={() => setPainelAberto(painelAberto === 'ligar' ? null : 'ligar')}
            disabled={nenhumFluxoLigado}
            title={nenhumFluxoLigado ? 'nenhum fluxo que ele dispara está ligado na agenda' : ''}
          >
            Ligar
          </button>
        )}
        <button style={s.botao} onClick={() => setPainelAberto(painelAberto === 'ajustar' ? null : 'ajustar')}>
          {painelAberto === 'ajustar' ? 'Fechar' : 'Ajustar'}
        </button>
        {l?.ativo && (d.situacao === 'pausado' || d.situacao === 'com-erro') && (
          <BotaoRetomar chave={d.chave} aoMudar={aoMudar} aoErrar={aoErrar} />
        )}
      </div>

      {(painelAberto === 'ligar' || painelAberto === 'desligar') && (
        <ConfirmacaoDeChave
          detector={d}
          ligar={painelAberto === 'ligar'}
          aoFechar={() => setPainelAberto(null)}
          aoMudar={aoMudar}
          aoErrar={aoErrar}
        />
      )}
      {painelAberto === 'ajustar' && (
        <EditorDoDetector detector={d} aoFechar={() => setPainelAberto(null)} aoMudar={aoMudar} aoErrar={aoErrar} />
      )}

      <details>
        <summary style={{ ...s.resumoDetalhe, marginTop: 0 }}>como funciona</summary>
        <div style={{ fontSize: '.8rem', marginTop: '.35rem' }}>
          <p style={{ margin: '0 0 .35rem' }}>{d.pergunta}</p>
          <p style={{ margin: 0, color: cor.fraco }}>Custo por volta: {d.custoPorVolta}.</p>
          <p style={{ margin: '.35rem 0 0', color: cor.fraco }}>
            Ele não escreve em lugar nenhum: quando vê mudança, enfileira o mesmo job da agenda, com as
            mesmas proteções. A varredura agendada continua sendo a garantia — o detector só encurta a
            espera.
          </p>
        </div>
      </details>
    </div>
  );
}

/**
 * A trava de credencial do RM, acima dos cartões: ela vale para os TRÊS, e um
 * aviso repetido em cada cartão faria parecer três problemas.
 */
function AvisoDaTrava({
  trava, chave, aoMudar, aoErrar,
}: {
  trava: NonNullable<PainelContinuo['travaDoRm']>;
  chave: string | undefined;
  aoMudar: () => void;
  aoErrar: (e: unknown) => void;
}) {
  return (
    <div style={s.aviso('atencao')}>
      <strong>O RM recusou a credencial da integração</strong> ({trava.recusas}ª recusa seguida). Os detectores
      esperam até <strong>{quando(trava.ate)}</strong> para não bloquear o usuário no RM — a pausa cresce a cada
      recusa. Se a recusa for de senha expirada, ela só passa quando alguém corrigir o cadastro do usuário no RM.
      <div style={{ ...s.fraco, fontSize: '.78rem', marginTop: '.3rem' }}>{textoLimpo(trava.motivo).slice(0, 200)}</div>
      {chave && (
        <div style={{ marginTop: '.45rem' }}>
          <BotaoRetomar chave={chave} aoMudar={aoMudar} aoErrar={aoErrar} rotulo="Senha corrigida — retomar agora" />
        </div>
      )}
    </div>
  );
}

function BotaoRetomar({
  chave, aoMudar, aoErrar, rotulo = 'Retomar',
}: { chave: string; aoMudar: () => void; aoErrar: (e: unknown) => void; rotulo?: string }) {
  const [enviando, setEnviando] = useState(false);
  async function retomar(): Promise<void> {
    setEnviando(true);
    try {
      await api.salvarContinuo(chave, { retomar: true, motivo: 'retomado pela tela' });
      aoMudar();
    } catch (e) {
      aoErrar(e);
    } finally {
      setEnviando(false);
    }
  }
  return (
    <button style={s.botao} onClick={() => void retomar()} disabled={enviando} title="Limpa a pausa e as falhas e volta a sondar na próxima volta">
      {enviando ? '…' : rotulo}
    </button>
  );
}

function Dado({ rotulo, valor, forte, dica }: { rotulo: string; valor: string; forte?: boolean; dica?: string }) {
  return (
    <div title={dica}>
      <div style={s.dadoRotulo}>{rotulo}</div>
      <div style={{ fontWeight: forte ? 700 : 500, fontSize: '.95rem' }}>{valor}</div>
    </div>
  );
}

const plural = (n: number, um: string, varios: string): string =>
  `${n.toLocaleString('pt-BR')} ${n === 1 ? um : varios}`;

/** A data local `YYYY-MM-DD`, para casar com o dia do contador (fuso de SP). */
function diaLocal(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(ms));
}

/**
 * Ligar/desligar com o efeito escrito por extenso — o mesmo padrão do
 * "Sincronizar agora": quem liga um detector de nota está decidindo que nota
 * passa a chegar ao registro acadêmico de minuto em minuto, e precisa ler isso
 * antes, não depois.
 */
function ConfirmacaoDeChave({
  detector: d, ligar, aoFechar, aoMudar, aoErrar,
}: {
  detector: DetectorNaTela;
  ligar: boolean;
  aoFechar: () => void;
  aoMudar: () => void;
  aoErrar: (e: unknown) => void;
}) {
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function confirmar(): Promise<void> {
    setEnviando(true);
    setErro(null);
    try {
      await api.salvarContinuo(d.chave, { ativo: ligar, motivo: motivo.trim() || undefined });
      aoMudar();
      aoFechar();
    } catch (e) {
      if (e instanceof ApiError && (e.status === 409 || e.status === 400 || e.status === 403)) {
        const c = e.corpo as { erro?: string; comoResolver?: string } | null;
        setErro([c?.erro, c?.comoResolver].filter(Boolean).join(' — ') || e.message);
      } else {
        setErro(e instanceof Error ? e.message : String(e));
        aoErrar(e);
      }
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div style={{ ...s.aviso(ligar ? 'atencao' : 'bom'), marginTop: 0 }}>
      <strong>{ligar ? `Ligar o detector de ${d.rotulo.toLowerCase()}` : `Desligar o detector de ${d.rotulo.toLowerCase()}`}</strong>
      <p style={{ margin: '.4rem 0 0', fontSize: '.84rem' }}>
        {ligar
          ? d.avisoAoLigar
          : 'As mudanças voltam a esperar o próximo horário da agenda. Nada que já foi escrito é desfeito.'}
      </p>
      <div style={{ ...s.linha, marginTop: '.5rem' }}>
        <input
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder="motivo (opcional, fica na auditoria)"
          style={{ ...s.campo, fontFamily: 'inherit', flex: '1 1 160px', minWidth: 0 }}
          disabled={enviando}
        />
        <button style={s.botao} onClick={() => void confirmar()} disabled={enviando}>
          {enviando ? 'Salvando…' : ligar ? 'Confirmar e ligar' : 'Confirmar'}
        </button>
        <button style={s.botao} onClick={aoFechar} disabled={enviando}>Cancelar</button>
      </div>
      {erro && <div style={{ color: cor.ruim, marginTop: '.4rem', fontSize: '.84rem' }}>{erro}</div>}
    </div>
  );
}

/** Intervalo e janela de horas. Sem campo livre: as opções já são o permitido. */
function EditorDoDetector({
  detector: d, aoFechar, aoMudar, aoErrar,
}: {
  detector: DetectorNaTela;
  aoFechar: () => void;
  aoMudar: () => void;
  aoErrar: (e: unknown) => void;
}) {
  const l = d.linha;
  const [intervalo, setIntervalo] = useState(l?.intervaloSegundos ?? d.padrao.intervaloSegundos);
  const [inicio, setInicio] = useState(l?.horaInicio ?? d.padrao.horaInicio);
  const [fim, setFim] = useState(l?.horaFim ?? d.padrao.horaFim);
  const [diaInteiro, setDiaInteiro] = useState((l?.horaInicio ?? 6) === (l?.horaFim ?? 22));
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const horas = Array.from({ length: 24 }, (_, h) => h);
  const fimEfetivo = diaInteiro ? inicio : fim;
  const mudou =
    intervalo !== (l?.intervaloSegundos ?? -1) || inicio !== (l?.horaInicio ?? -1) || fimEfetivo !== (l?.horaFim ?? -1);
  // ~ quantas olhadas por dia, para quem escolhe o intervalo ver o custo.
  const horasNaJanela = diaInteiro ? 24 : (fimEfetivo - inicio + 24) % 24 || 24;
  const olhadasPorDia = Math.round((horasNaJanela * 3600) / intervalo);

  async function salvar(): Promise<void> {
    setEnviando(true);
    setErro(null);
    try {
      await api.salvarContinuo(d.chave, { intervaloSegundos: intervalo, horaInicio: inicio, horaFim: fimEfetivo });
      aoMudar();
      aoFechar();
    } catch (e) {
      if (e instanceof ApiError && (e.status === 400 || e.status === 403)) setErro(e.message);
      else {
        setErro(e instanceof Error ? e.message : String(e));
        aoErrar(e);
      }
    } finally {
      setEnviando(false);
    }
  }

  const select = { ...s.campo, fontFamily: 'inherit', padding: '.3rem' };
  return (
    <div style={{ borderTop: `1px solid ${cor.borda}`, paddingTop: '.6rem', display: 'grid', gap: '.5rem', fontSize: '.86rem' }}>
      <label style={{ ...s.linha, gap: '.4rem' }}>
        <span style={{ minWidth: 90 }}>Perguntar a cada</span>
        <select value={intervalo} onChange={(e) => setIntervalo(Number(e.target.value))} style={select}>
          {INTERVALOS.map((x) => <option key={x} value={x}>{intervaloLegivel(x)}</option>)}
        </select>
      </label>
      <div style={{ ...s.linha, gap: '.4rem' }}>
        <span style={{ minWidth: 90 }}>Horário</span>
        <select value={inicio} onChange={(e) => setInicio(Number(e.target.value))} style={select} aria-label="início">
          {horas.map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}h</option>)}
        </select>
        {!diaInteiro && (
          <>
            <span>até</span>
            <select value={fim} onChange={(e) => setFim(Number(e.target.value))} style={select} aria-label="fim">
              {horas.map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}h</option>)}
            </select>
          </>
        )}
        <label style={{ ...s.linha, gap: '.25rem' }}>
          <input type="checkbox" checked={diaInteiro} onChange={(e) => setDiaInteiro(e.target.checked)} />
          dia inteiro
        </label>
      </div>
      <div style={s.fraco}>
        ≈ {olhadasPorDia.toLocaleString('pt-BR')} olhadas por dia. Uma mudança chega em até{' '}
        {intervaloLegivel(intervalo)} + o tempo da passada.
      </div>
      <div style={s.linha}>
        <button style={s.botao} onClick={() => void salvar()} disabled={enviando || !mudou}>
          {enviando ? 'Salvando…' : 'Salvar'}
        </button>
        <button style={s.botao} onClick={aoFechar} disabled={enviando}>Cancelar</button>
      </div>
      {erro && <div style={{ color: cor.ruim }}>{erro}</div>}
    </div>
  );
}
