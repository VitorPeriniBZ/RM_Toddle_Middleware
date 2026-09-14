import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type PainelDeAcessos,
  type Papel,
  type PessoaAguardando,
  type PessoaComAcesso,
} from '../api';
import { cor, s } from '../estilos';

/**
 * QUEM PODE O QUÊ.
 *
 * ─── A TELA EXPLICA O PAPEL, PORQUE O NOME NÃO EXPLICA ──────────────────────
 *
 * `integration_operator` e `mapping_manager` não dizem nada a quem vai clicar.
 * Uma lista de cinco palavras em inglês num `<select>` faz a pessoa escolher a
 * que parece mais próxima — e "parecer mais próxima" é como alguém acaba com
 * poder de mudar o job que escreve nota no registro acadêmico. Cada papel aqui
 * vem com a frase do que ele libera, ao lado da opção, não num tooltip.
 *
 * ─── A FILA DE ESPERA NÃO É UM CONVITE ──────────────────────────────────────
 *
 * Não há "convidar por e-mail": a identidade é a claim `sub` do Google, que só
 * existe depois do primeiro login. Quem tentou entrar e levou 403 já está no
 * banco — `exigirPapel` cria a identidade ANTES de checar o papel. Essa fila
 * sempre existiu; faltava alguém olhar. O fluxo é: a pessoa tenta entrar uma
 * vez, aparece em "aguardando acesso", e alguém dá o papel.
 */

/**
 * O que cada papel LIBERA, em uma frase.
 *
 * Escrito do ponto de vista de quem concede ("esta pessoa vai poder…"), e não do
 * ponto de vista do sistema ("permite acesso ao endpoint X").
 */
const EXPLICACAO: Record<Papel, { titulo: string; libera: string; peso: 'baixo' | 'medio' | 'alto' }> = {
  viewer: {
    titulo: 'Leitura',
    libera: 'Ver agenda, jobs, de-para e auditoria. Não muda nada.',
    peso: 'baixo',
  },
  mapping_manager: {
    titulo: 'De-para',
    libera: 'Propor e revisar vínculos entre RM e Toddle. Não liga job nem aprova escrita.',
    peso: 'medio',
  },
  integration_operator: {
    titulo: 'Operação',
    libera:
      'Mudar horário dos fluxos, ligar e desligar, e rodar um fluxo na hora — inclusive o que ' +
      'escreve nota no RM.',
    peso: 'alto',
  },
  approver: {
    titulo: 'Aprovação',
    libera: 'Decidir as operações que pararam no gate de volume, liberando escrita no RM.',
    peso: 'alto',
  },
  tenant_admin: {
    titulo: 'Administração',
    libera: 'Tudo o que está acima, mais conceder e remover o acesso de outras pessoas.',
    peso: 'alto',
  },
};

const ORDEM: Papel[] = ['viewer', 'mapping_manager', 'integration_operator', 'approver', 'tenant_admin'];

function comoChamar(p: { nome: string | null; email: string | null; subject: string }): string {
  return p.nome ?? p.email ?? p.subject;
}

export function Acessos({ aoErrar }: { aoErrar: (e: unknown) => void }) {
  const [painel, setPainel] = useState<PainelDeAcessos | null>(null);
  const [recusa, setRecusa] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);

  function carregar(): void {
    api.acessos().then(setPainel).catch(aoErrar);
  }
  useEffect(carregar, []);

  /**
   * Um só caminho para as duas mudanças.
   *
   * A recusa de REGRA (409 — "este é o último tenant_admin") não é erro de
   * sistema e não vai para `aoErrar`: ela é a resposta à pergunta que a pessoa
   * fez, e tem de aparecer ao lado do botão que ela clicou, com o que fazer.
   */
  async function mudar(fn: () => Promise<unknown>, chave: string): Promise<void> {
    setOcupado(chave);
    setRecusa(null);
    try {
      await fn();
      carregar();
    } catch (e) {
      if (e instanceof ApiError && (e.status === 409 || e.status === 400)) {
        const corpo = e.corpo as { erro?: string; comoResolver?: string } | null;
        setRecusa([corpo?.erro, corpo?.comoResolver].filter(Boolean).join(' — '));
      } else {
        aoErrar(e);
      }
    } finally {
      setOcupado(null);
    }
  }

  if (!painel) return <p style={s.fraco}>Consultando…</p>;

  return (
    <section>
      <p style={{ ...s.fraco, marginTop: '.8rem' }}>
        Entrar com a conta da escola é <strong>autenticação</strong>; o que a pessoa pode fazer vem
        daqui. Quem não tem papel nenhum não abre nem as telas de leitura.
      </p>

      {recusa && <div style={s.aviso('ruim')}>{recusa}</div>}

      {painel.administradores <= 1 && (
        <div style={s.aviso('atencao')}>
          <strong>Só há um administrador.</strong> Enquanto for assim, o papel{' '}
          <code style={s.mono}>tenant_admin</code> não pode ser removido — sem ele ninguém consegue
          conceder acesso pela tela, e a volta seria por linha de comando no servidor. Conceda{' '}
          <code style={s.mono}>tenant_admin</code> a mais alguém para destravar.
        </div>
      )}

      <Aguardando
        pessoas={painel.aguardando}
        papeis={ORDEM}
        ocupado={ocupado}
        aoConceder={(id, papel) => mudar(() => api.conceder(id, papel), `conceder:${id}`)}
      />

      <ComAcesso
        pessoas={painel.comAcesso}
        administradores={painel.administradores}
        ocupado={ocupado}
        aoConceder={(id, papel) => mudar(() => api.conceder(id, papel), `conceder:${id}`)}
        aoRevogar={(id, papel) => mudar(() => api.revogar(id, papel), `revogar:${id}:${papel}`)}
      />

      <Legenda />
    </section>
  );
}

/**
 * A fila de espera.
 *
 * Vem ANTES da lista de quem já tem acesso, de propósito: é a única parte desta
 * tela que alguém está esperando. A lista de quem tem acesso é consulta; esta é
 * tarefa.
 */
function Aguardando({
  pessoas, papeis, ocupado, aoConceder,
}: {
  pessoas: PessoaAguardando[];
  papeis: Papel[];
  ocupado: string | null;
  aoConceder: (userIdentityId: string, papel: Papel) => void;
}) {
  if (pessoas.length === 0) {
    return (
      <div style={s.cartao}>
        <h2 style={{ margin: 0, fontSize: '1rem' }}>Aguardando acesso</h2>
        <p style={{ ...s.fraco, margin: '.4rem 0 0' }}>
          Ninguém na fila. Quem tentar entrar e for recusado aparece aqui — peça à pessoa para
          entrar uma vez.
        </p>
      </div>
    );
  }

  return (
    <div style={s.cartao}>
      <div style={{ ...s.linha, justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0, fontSize: '1rem' }}>Aguardando acesso</h2>
        <span style={s.selo('atencao')}>{pessoas.length}</span>
      </div>
      <p style={{ ...s.fraco, margin: '.3rem 0 .6rem' }}>
        Entraram com a conta da escola e foram recusadas por não ter papel.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table style={s.tabela}>
          <thead>
            <tr>
              <th style={s.th}>Pessoa</th>
              <th style={s.th}>Tentou desde</th>
              <th style={s.th}>Conceder</th>
            </tr>
          </thead>
          <tbody>
            {pessoas.map((p) => (
              <tr key={p.userIdentityId}>
                <td style={s.td}>
                  <strong>{comoChamar(p)}</strong>
                  {p.email && p.nome && <div style={s.fraco}>{p.email}</div>}
                </td>
                <td style={{ ...s.td, whiteSpace: 'nowrap' }}>
                  {new Date(p.desde).toLocaleString('pt-BR')}
                </td>
                <td style={s.td}>
                  <SeletorDePapel
                    desabilitado={ocupado === `conceder:${p.userIdentityId}`}
                    papeis={papeis}
                    aoEscolher={(papel) => aoConceder(p.userIdentityId, papel)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ComAcesso({
  pessoas, administradores, ocupado, aoConceder, aoRevogar,
}: {
  pessoas: PessoaComAcesso[];
  administradores: number;
  ocupado: string | null;
  aoConceder: (userIdentityId: string, papel: Papel) => void;
  aoRevogar: (userIdentityId: string, papel: Papel) => void;
}) {
  return (
    <div style={s.cartao}>
      <h2 style={{ margin: 0, fontSize: '1rem' }}>Com acesso</h2>
      {pessoas.length === 0 ? (
        <p style={{ ...s.fraco, margin: '.4rem 0 0' }}>
          Ninguém — o que só acontece antes do primeiro <code style={s.mono}>npm run conceder</code>.
        </p>
      ) : (
        <div style={{ overflowX: 'auto', marginTop: '.6rem' }}>
          <table style={s.tabela}>
            <thead>
              <tr>
                <th style={s.th}>Pessoa</th>
                <th style={s.th}>Papéis</th>
                <th style={s.th}>Acrescentar</th>
              </tr>
            </thead>
            <tbody>
              {pessoas.map((p) => {
                const faltantes = ORDEM.filter((x) => !p.papeis.includes(x));
                return (
                  <tr key={p.userIdentityId}>
                    <td style={s.td}>
                      <strong>{comoChamar(p)}</strong>
                      {p.email && p.nome && <div style={s.fraco}>{p.email}</div>}
                      {p.provider === 'cli' && (
                        <div style={s.fraco}>
                          identidade de linha de comando, não é uma conta do Google
                        </div>
                      )}
                    </td>
                    <td style={s.td}>
                      <div style={{ ...s.linha, gap: '.35rem' }}>
                        {ORDEM.filter((x) => p.papeis.includes(x)).map((papel) => {
                          // O ÚLTIMO administrador não pode perder o papel, e o
                          // botão diz isso ANTES do clique. Recusar depois
                          // ensina a clicar e ver no que dá.
                          const ultimoAdmin = papel === 'tenant_admin' && administradores <= 1;
                          return (
                            <button
                              key={papel}
                              style={{
                                ...s.selo(EXPLICACAO[papel].peso === 'alto' ? 'atencao' : 'neutro'),
                                border: `1px solid ${cor.borda}`,
                                cursor: ultimoAdmin ? 'not-allowed' : 'pointer',
                                opacity: ultimoAdmin ? 0.5 : 1,
                              }}
                              disabled={ultimoAdmin || ocupado === `revogar:${p.userIdentityId}:${papel}`}
                              title={
                                ultimoAdmin
                                  ? 'é o último tenant_admin — conceda a outra pessoa antes'
                                  : `remover "${EXPLICACAO[papel].titulo}" de ${comoChamar(p)}`
                              }
                              onClick={() => aoRevogar(p.userIdentityId, papel)}
                            >
                              {papel} ✕
                            </button>
                          );
                        })}
                      </div>
                    </td>
                    <td style={s.td}>
                      {faltantes.length === 0 ? (
                        <span style={s.fraco}>tem todos</span>
                      ) : (
                        <SeletorDePapel
                          desabilitado={ocupado === `conceder:${p.userIdentityId}`}
                          papeis={faltantes}
                          aoEscolher={(papel) => aoConceder(p.userIdentityId, papel)}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * O seletor não dispara sozinho na mudança.
 *
 * `onChange` que já concede transforma uma rolagem de teclado num papel
 * concedido. São dois passos: escolher e confirmar — e o botão de confirmar diz
 * o nome do papel, então o clique final carrega a informação.
 */
function SeletorDePapel({
  papeis, desabilitado, aoEscolher,
}: {
  papeis: Papel[];
  desabilitado: boolean;
  aoEscolher: (papel: Papel) => void;
}) {
  const [escolhido, setEscolhido] = useState<Papel | ''>('');
  return (
    <div style={{ ...s.linha, gap: '.4rem' }}>
      <select
        style={s.campo}
        value={escolhido}
        disabled={desabilitado}
        onChange={(e) => setEscolhido(e.target.value as Papel | '')}
      >
        <option value="">escolha…</option>
        {papeis.map((p) => (
          <option key={p} value={p}>
            {p} — {EXPLICACAO[p].titulo}
          </option>
        ))}
      </select>
      <button
        style={{ ...s.botao, opacity: escolhido ? 1 : 0.5 }}
        disabled={!escolhido || desabilitado}
        onClick={() => {
          if (escolhido) aoEscolher(escolhido);
          setEscolhido('');
        }}
      >
        {desabilitado ? 'concedendo…' : 'Conceder'}
      </button>
      {escolhido && <span style={s.fraco}>{EXPLICACAO[escolhido].libera}</span>}
    </div>
  );
}

function Legenda() {
  return (
    <div style={s.cartao}>
      <h2 style={{ margin: 0, fontSize: '1rem' }}>O que cada papel libera</h2>
      <table style={{ ...s.tabela, marginTop: '.5rem' }}>
        <tbody>
          {ORDEM.map((papel) => (
            <tr key={papel}>
              <td style={{ ...s.td, whiteSpace: 'nowrap' }}>
                <code style={s.mono}>{papel}</code>
                {EXPLICACAO[papel].peso === 'alto' && (
                  <span style={{ ...s.selo('atencao'), marginLeft: '.4rem' }}>escreve</span>
                )}
              </td>
              <td style={s.td}>{EXPLICACAO[papel].libera}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ ...s.fraco, margin: '.6rem 0 0' }}>
        Os papéis não formam hierarquia — ter <code style={s.mono}>approver</code> não inclui{' '}
        <code style={s.mono}>viewer</code>. A única exceção é{' '}
        <code style={s.mono}>tenant_admin</code>, que satisfaz qualquer exigência. Toda concessão e
        toda remoção ficam registradas na aba Auditoria.
      </p>
    </div>
  );
}
