import { useEffect, useState } from 'react';
import { api, ApiError, setIdToken, type AuthConfig } from './api';

/**
 * Primeira tela: login e leitura. Nenhum botão desta versão escreve em lugar
 * algum — nem no nosso banco, nem no RM, nem no Toddle.
 *
 * O token fica em memória, NÃO em localStorage. Token em localStorage é legível
 * por qualquer script na página e sobrevive ao fechamento da aba; recarregar e
 * logar de novo é um preço baixo para um sistema que vai aprovar lançamento em
 * registro acadêmico. Quando houver sessão de servidor, ela substitui isto.
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

export function App() {
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [estado, setEstado] = useState<Estado>('carregando');
  const [erro, setErro] = useState<string | null>(null);

  const [health, setHealth] = useState<Awaited<ReturnType<typeof api.health>> | null>(null);
  const [resumo, setResumo] = useState<Awaited<ReturnType<typeof api.resumo>> | null>(null);
  const [auditoria, setAuditoria] = useState<Awaited<ReturnType<typeof api.auditoriaYearGroups>> | null>(null);
  const [curriculumId, setCurriculumId] = useState('');

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
        setEstado('logado');
        setErro(null);
      },
    });
    window.google.accounts.id.renderButton(alvo, { theme: 'outline', size: 'large', locale: 'pt-BR' });
  }, [estado, authConfig]);

  async function carregar(): Promise<void> {
    setErro(null);
    try {
      const [h, r] = await Promise.all([api.health(), api.resumo()]);
      setHealth(h);
      setResumo(r);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setIdToken(null);
        setEstado('deslogado');
        setErro(e.status === 403 ? 'Conta fora dos domínios autorizados.' : 'Sessão expirada — entre de novo.');
        return;
      }
      setErro(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => { if (estado === 'logado') void carregar(); }, [estado]);

  async function auditar(): Promise<void> {
    setErro(null);
    try {
      setAuditoria(await api.auditoriaYearGroups(curriculumId.trim()));
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 860, margin: '2rem auto', padding: '0 1rem' }}>
      <h1 style={{ fontSize: '1.4rem' }}>Middleware RM ↔ Toddle</h1>

      {estado === 'carregando' && <p>Consultando a API…</p>}

      {estado === 'erro' && (
        <p style={{ color: '#b00' }}>
          {erro}
          <br />
          <small>A API sobe com <code>npm run api</code> na porta 3333.</small>
        </p>
      )}

      {estado === 'deslogado' && (
        <section>
          <p>Entre com a conta da escola.</p>
          <div id="botao-google" />
          {erro && <p style={{ color: '#b00' }}>{erro}</p>}
        </section>
      )}

      {estado === 'logado' && (
        <>
          {authConfig?.authMode === 'localhost' && (
            <p style={{ background: '#fff4d6', border: '1px solid #e0c060', padding: '.6rem .8rem' }}>
              <strong>Modo de desenvolvimento.</strong> A API está sem autenticação
              (<code>API_AUTH_MODE=localhost</code>) e só aceita conexões locais.
            </p>
          )}
          {erro && <p style={{ color: '#b00' }}>{erro}</p>}

          <h2 style={{ fontSize: '1.1rem' }}>Saúde</h2>
          {health ? (
            <ul>
              <li>tenant: <strong>{health.tenant}</strong></li>
              <li>configVersion: <code>{health.configVersion}</code></li>
              {health.dependencias.map((d) => (
                <li key={d.nome}>{d.nome}: {d.ok ? 'ok' : `falha — ${d.erro}`}</li>
              ))}
            </ul>
          ) : <p>—</p>}

          <h2 style={{ fontSize: '1.1rem' }}>Mapeamentos</h2>
          {resumo ? (
            <table cellPadding={6} style={{ borderCollapse: 'collapse' }}>
              <thead><tr><th align="left">tipo</th><th align="left">estado</th><th align="right">total</th></tr></thead>
              <tbody>
                {resumo.itens.map((i) => (
                  <tr key={i.entityType + i.state} style={{ borderTop: '1px solid #ddd' }}>
                    <td>{i.entityType}</td><td>{i.state}</td><td align="right">{i.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p>—</p>}

          <h2 style={{ fontSize: '1.1rem' }}>Auditoria de year group</h2>
          <p style={{ fontSize: '.9rem', color: '#555' }}>
            Exige o currículo: sem ele a API do Toddle devolve a organização achatada,
            onde nomes de year group colidem entre currículos — foi assim que um
            de-para foi feito para a escada errada.
          </p>
          <input
            value={curriculumId}
            onChange={(e) => setCurriculumId(e.target.value)}
            placeholder="curriculumId"
            style={{ padding: '.4rem', width: 260 }}
          />
          <button onClick={() => void auditar()} disabled={!curriculumId.trim()} style={{ marginLeft: 8, padding: '.4rem .8rem' }}>
            Auditar
          </button>
          {auditoria && (
            <div style={{ marginTop: '1rem' }}>
              <p>
                {auditoria.yearGroupsNoToddle} year groups neste currículo · {auditoria.mapeamentos} mapeamentos ·{' '}
                <strong style={{ color: auditoria.problemas.length ? '#b00' : '#070' }}>
                  {auditoria.problemas.length} problema(s)
                </strong>
              </p>
              {auditoria.problemas.length > 0 && (
                <ul>
                  {auditoria.problemas.slice(0, 10).map((p) => (
                    <li key={p.rmCode}><code>{p.rmCode}</code> — {p.causa}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </main>
  );
}
