import { useEffect, useState } from 'react';
import { api, ApiError, setIdToken, type AuthConfig } from './api';
import { cor, s } from './estilos';
import { Agenda } from './painel/Agenda';
import { DePara } from './painel/DePara';
import { Auditoria } from './painel/Auditoria';

/**
 * A tela: login, e três assuntos.
 *
 * O token fica em memória, NÃO em localStorage. Token em localStorage é legível
 * por qualquer script na página e sobrevive ao fechamento da aba; recarregar e
 * logar de novo é um preço baixo para um sistema que muda o horário de um job que
 * escreve em registro acadêmico. Quando houver sessão de servidor, ela substitui
 * isto.
 *
 * ─── O 403 É PARTE DO CAMINHO, NÃO UM ERRO ──────────────────────────────────
 *
 * Autenticar com a conta da escola não dá acesso: quem pode o quê vive na tabela
 * `membership`, que nasce vazia. O primeiro acesso é concedido por script, de
 * fora — uma tela que pudesse conceder o primeiro papel a si mesma não seria uma
 * porta trancada. Por isso o 403 desta tela mostra o comando pronto em vez de só
 * dizer "sem permissão".
 */

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (o: { client_id: string; callback: (r: { credential: string }) => void }) => void;
          renderButton: (el: HTMLElement, o: Record<string, unknown>) => void;
        };
      };
    };
  }
}

type Estado = 'carregando' | 'deslogado' | 'logado' | 'erro';
type Aba = 'agenda' | 'de-para' | 'auditoria' | 'saude';

export function App() {
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [estado, setEstado] = useState<Estado>('carregando');
  const [erro, setErro] = useState<string | null>(null);
  const [semAcesso, setSemAcesso] = useState<{ comoLiberar?: string; erro?: string } | null>(null);
  const [aba, setAba] = useState<Aba>('agenda');

  // 1. Descobre o modo de autenticação com a própria API.
  useEffect(() => {
    api.authConfig()
      .then((c) => {
        setAuthConfig(c);
        // No modo localhost não há login: a API dispensa token (e só escuta em
        // 127.0.0.1). Serve para desenvolver sem depender do Google.
        setEstado(c.authMode === 'localhost' ? 'logado' : 'deslogado');
      })
      .catch((e) => {
        setEstado('erro');
        setErro(e instanceof Error ? `API inacessível: ${e.message}` : String(e));
      });
  }, []);

  // 2. Monta o botão do Google quando precisa de login.
  useEffect(() => {
    if (estado !== 'deslogado' || !authConfig?.clientId) return;
    const alvo = document.getElementById('botao-google');
    if (!alvo || !window.google) return;

    window.google.accounts.id.initialize({
      client_id: authConfig.clientId,
      callback: (resposta) => {
        setIdToken(resposta.credential);
        setSemAcesso(null);
        setEstado('logado');
        setErro(null);
      },
    });
    window.google.accounts.id.renderButton(alvo, { theme: 'outline', size: 'large', locale: 'pt-BR' });
  }, [estado, authConfig]);

  /**
   * Tratamento único de erro das abas.
   *
   * 401 volta para o login; 403 NÃO volta — a conta é válida, só não tem papel, e
   * mandar de volta para o botão do Google faria a pessoa logar em círculos sem
   * nunca ler o que precisa fazer.
   */
  function tratar(e: unknown): void {
    if (e instanceof ApiError && e.status === 401) {
      setIdToken(null);
      setEstado('deslogado');
      setErro('Sessão expirada — entre de novo.');
      return;
    }
    if (e instanceof ApiError && e.status === 403) {
      const corpo = e.corpo as { erro?: string; comoLiberar?: string } | null;
      setSemAcesso({ erro: corpo?.erro ?? e.message, comoLiberar: corpo?.comoLiberar });
      return;
    }
    setErro(e instanceof Error ? e.message : String(e));
  }

  return (
    <main style={s.main}>
      <h1 style={s.h1}>Middleware RM ↔ Toddle</h1>
      <p style={s.fraco}>Plano de controle: agenda, de-para e auditoria.</p>

      {estado === 'carregando' && <p>Consultando a API…</p>}

      {estado === 'erro' && (
        <p style={{ color: cor.ruim }}>
          {erro}
          <br />
          <small>A API sobe com <code style={s.mono}>npm run api</code> na porta 3333.</small>
        </p>
      )}

      {estado === 'deslogado' && (
        <section>
          <p>Entre com a conta da escola.</p>
          <div id="botao-google" />
          {erro && <p style={{ color: cor.ruim }}>{erro}</p>}
        </section>
      )}

      {estado === 'logado' && (
        <>
          {authConfig?.authMode === 'localhost' && (
            <div style={s.aviso('atencao')}>
              <strong>Modo de desenvolvimento.</strong> A API está sem autenticação
              (<code style={s.mono}>API_AUTH_MODE=localhost</code>), só aceita conexões locais e
              dispensa a checagem de papel.
            </div>
          )}

          {semAcesso && (
            <div style={s.aviso('ruim')}>
              <strong>{semAcesso.erro}</strong>
              <p style={{ margin: '.4rem 0 0' }}>
                Autenticar com a conta da escola não dá acesso: pertencer ao Workspace é
                autenticação, não autorização. O papel vem da tabela <code style={s.mono}>membership</code>.
              </p>
              {semAcesso.comoLiberar && (
                <p style={{ margin: '.4rem 0 0' }}>
                  Rode, na máquina do middleware:
                  <br />
                  <code style={{ ...s.mono, userSelect: 'all' }}>{semAcesso.comoLiberar}</code>
                </p>
              )}
            </div>
          )}

          {erro && <div style={s.aviso('ruim')}>{erro}</div>}

          <div style={s.abas}>
            {([
              ['agenda', 'Agenda'],
              ['de-para', 'De-para'],
              ['auditoria', 'Auditoria'],
              ['saude', 'Saúde'],
            ] as Array<[Aba, string]>).map(([chave, rotulo]) => (
              <button key={chave} style={s.aba(aba === chave)} onClick={() => { setErro(null); setAba(chave); }}>
                {rotulo}
              </button>
            ))}
          </div>

          {aba === 'agenda' && <Agenda aoErrar={tratar} />}
          {aba === 'de-para' && <DePara aoErrar={tratar} />}
          {aba === 'auditoria' && <Auditoria aoErrar={tratar} />}
          {aba === 'saude' && <Saude aoErrar={tratar} />}
        </>
      )}
    </main>
  );
}

/**
 * Saúde e panorama.
 *
 * Era uma lista de bullets em que "tenant", "configVersion" e cada dependência
 * tinham o mesmo peso — e o que se quer saber ao abrir é uma coisa só: alguma
 * dependência caiu? Por isso as dependências viraram a primeira coisa, com
 * estado visível, e a identidade do ambiente desceu para uma tira de rodapé.
 */
function Saude({ aoErrar }: { aoErrar: (e: unknown) => void }) {
  const [health, setHealth] = useState<Awaited<ReturnType<typeof api.health>> | null>(null);
  const [resumo, setResumo] = useState<Awaited<ReturnType<typeof api.resumo>> | null>(null);

  useEffect(() => {
    Promise.all([api.health(), api.resumo()])
      .then(([h, r]) => { setHealth(h); setResumo(r); })
      .catch(aoErrar);
  }, []);

  if (!health) return <p style={s.fraco}>Consultando…</p>;

  const caidas = health.dependencias.filter((d) => !d.ok);

  return (
    <>
      <div style={{ ...s.barra, justifyContent: 'space-between' }}>
        <div style={s.linha}>
          <span style={s.selo(caidas.length === 0 ? 'bom' : 'ruim')}>
            {caidas.length === 0 ? 'tudo no ar' : `${caidas.length} fora do ar`}
          </span>
          <span style={s.fraco}>
            {health.dependencias.length} dependência(s) verificada(s)
          </span>
        </div>
      </div>

      <h2 style={s.h2}>Dependências</h2>
      <table style={s.tabela}>
        <tbody>
          {health.dependencias.map((d) => (
            <tr key={d.nome}>
              <td style={{ ...s.td, width: 150 }}>{d.nome}</td>
              <td style={{ ...s.td, width: 90 }}>
                <span style={s.selo(d.ok ? 'bom' : 'ruim')}>{d.ok ? 'ok' : 'falha'}</span>
              </td>
              <td style={{ ...s.td, color: cor.ruim, fontSize: '.82rem' }}>{d.ok ? '' : d.erro}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={s.h2}>Mapeamentos</h2>
      {resumo ? (
        <table style={s.tabela}>
          <thead>
            <tr>
              <th style={s.th}>entidade</th>
              <th style={s.th}>estado</th>
              <th style={{ ...s.th, textAlign: 'right' }}>total</th>
            </tr>
          </thead>
          <tbody>
            {resumo.itens.map((i) => (
              <tr key={i.entityType + i.state}>
                <td style={{ ...s.td, ...s.mono }}>{i.entityType}</td>
                <td style={s.td}>
                  <span style={s.selo(i.state === 'active' ? 'bom' : 'neutro')}>{i.state}</span>
                </td>
                <td style={{ ...s.td, textAlign: 'right' }}>{i.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p style={s.fraco}>—</p>}

      {/* Identidade do ambiente: raramente é a pergunta, mas é o que se confere
          quando a resposta não faz sentido ("isto está apontando para onde?"). */}
      <div style={{ ...s.tira, marginTop: '1.2rem', paddingTop: '.6rem', borderTop: `1px solid ${cor.borda}` }}>
        <span><span style={s.dadoRotulo}>tenant </span><strong>{health.tenant}</strong></span>
        <span>
          <span style={s.dadoRotulo}>configVersion </span>
          <code style={s.mono}>{health.configVersion}</code>
        </span>
      </div>
    </>
  );
}
