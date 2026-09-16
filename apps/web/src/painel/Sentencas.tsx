import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type ConferenciaDeSentenca,
  type PainelDeSentencas,
  type ResultadoDaCarga,
} from '../api';
import { cor, s } from '../estilos';

/**
 * AS SENTENÇAS DO RM — a fonte de tudo, e a coisa mais fácil de perder.
 *
 * ─── POR QUE ESTA ABA EXISTE ────────────────────────────────────────────────
 *
 * As seis Sentenças moram em `GCONSSQL`, que é uma tabela de DADO. Toda cópia de
 * base por cima do ambiente apaga as seis. Já aconteceu duas vezes, e as duas
 * vezes custaram dias — não porque recadastrar seja difícil (20 a 40 minutos),
 * mas porque ninguém soube que tinham sumido. O middleware seguia de pé,
 * respondendo, com os jobs verdes, lendo uma fonte que não existia mais.
 *
 * Por isso a aba abre mostrando ESTADO, e o botão vem depois. Se esta tela só
 * tivesse o botão, ela resolveria o problema de 40 minutos e deixaria o de dias.
 *
 * ─── O QUE "OK" QUER DIZER AQUI ─────────────────────────────────────────────
 *
 * Três camadas, e as três têm de passar:
 *
 *   releitura — o corpo no RM é caractere a caractere igual ao `.sql`, E as
 *               flags `SEMSEG*` batem com o manifesto (são elas que fazem o RM
 *               remover coluna ou linha sem avisar)
 *   execução  — a Sentença roda sem o RM recusar
 *   volume    — voltou mais que zero linha
 *
 * Coluna que não veio na resposta aparece como AVISO, e não reprova: o dataset
 * do .NET omite a coluna nula, então "removida pela segurança" e "nula em todas
 * as linhas" são indistinguíveis pelo dado. Quem decide isso é a checagem de
 * flags, que é determinística.
 *
 * A abertura da tela roda só a primeira, porque conferir de verdade executa a
 * `TODDLE.NOTAS` (~7 mil linhas por SOAP) e uma tela lenta é uma tela que
 * ninguém abre. Quando só a releitura rodou, a coluna diz "não conferida" — e
 * não verde. A diferença entre "não verifiquei" e "está bom" é a diferença
 * entre este painel e um enfeite.
 */

const TOM: Record<string, 'bom' | 'ruim' | 'atencao' | 'neutro'> = {
  ok: 'bom',
  falta: 'ruim',
  parcial: 'atencao',
};

function situacao(i: ConferenciaDeSentenca): { rotulo: string; tom: 'bom' | 'ruim' | 'atencao' | 'neutro' } {
  if (!i.existeNoRm) return { rotulo: 'não existe no RM', tom: TOM.falta };
  if (!i.releitura.ok) return { rotulo: 'corpo diverge', tom: TOM.falta };
  if (!i.verificacaoCompleta) return { rotulo: 'corpo ok, não conferida', tom: TOM.parcial };
  if (i.confere) return { rotulo: 'confere', tom: TOM.ok };
  return { rotulo: `reprovou: ${i.reprovouEm}`, tom: TOM.falta };
}

export function Sentencas({ aoErrar }: { aoErrar: (e: unknown) => void }) {
  const [dados, setDados] = useState<PainelDeSentencas | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [carga, setCarga] = useState<ResultadoDaCarga | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const [motivo, setMotivo] = useState('');
  const [erroLocal, setErroLocal] = useState<string | null>(null);

  async function carregar(): Promise<void> {
    setCarregando(true);
    setErroLocal(null);
    try {
      setDados(await api.sentencas());
    } catch (e) {
      aoErrar(e);
    } finally {
      setCarregando(false);
    }
  }

  useEffect(() => {
    void carregar();
  }, []);

  async function conferirTudo(): Promise<void> {
    setCarregando(true);
    setErroLocal(null);
    try {
      setDados(await api.conferirSentencas());
    } catch (e) {
      setErroLocal(e instanceof ApiError ? e.message : String(e));
    } finally {
      setCarregando(false);
    }
  }

  async function restaurar(): Promise<void> {
    setCarregando(true);
    setErroLocal(null);
    try {
      const r = await api.restaurarSentencas(motivo.trim() || 'carga inicial pelo Plano de Controle');
      setCarga(r);
      setConfirmando(false);
      setMotivo('');
      // Relê o estado do zero: o que a carga devolveu é o que ELA mediu, e a
      // tela tem de mostrar o que o RM diz agora, não o que a ação achou.
      setDados(await api.sentencas());
    } catch (e) {
      setErroLocal(e instanceof ApiError ? e.message : String(e));
    } finally {
      setCarregando(false);
    }
  }

  if (!dados) {
    return <p style={{ ...s.fraco, marginTop: '1rem' }}>Lendo as Sentenças do RM…</p>;
  }

  const faltando = dados.ausentes + dados.divergentes;

  return (
    <>
      <div style={{ ...s.barra, justifyContent: 'space-between', marginTop: '1rem' }}>
        <div style={s.linha}>
          <span style={s.selo(faltando > 0 ? 'ruim' : 'bom')}>
            {faltando > 0 ? `${faltando} de ${dados.itens.length} fora do ar` : 'as seis estão no RM'}
          </span>
          <span style={s.fraco}>
            coligada {dados.coligada} · período letivo {dados.periodoLetivo ?? '(vazio)'}
          </span>
        </div>
        <div style={s.linha}>
          <button style={s.botao} onClick={() => void carregar()} disabled={carregando}>
            {carregando ? 'Lendo…' : 'Reler'}
          </button>
          <button style={s.botao} onClick={() => void conferirTudo()} disabled={carregando}>
            Conferir de verdade
          </button>
        </div>
      </div>

      {/* Fila pausada não dá erro em lugar nenhum: ela simplesmente para de
          processar. Se a API caiu no meio de uma carga, é aqui que aparece — e
          tem de aparecer em vermelho, porque o sistema parece saudável assim. */}
      {dados.filasPausadas.length > 0 && (
        <div style={s.aviso('ruim')}>
          <strong>Fila pausada: {dados.filasPausadas.join(', ')}</strong>
          <p style={{ margin: '.4rem 0 0' }}>
            A carga pausa as filas enquanto grava e as retoma no fim. Se alguma ficou pausada, ou a
            carga foi interrompida no meio, ou alguém pausou de propósito. Enquanto estiver assim,
            nenhum job desta fila roda — e nada vai acusar isso.
          </p>
        </div>
      )}

      {erroLocal && <div style={s.aviso('ruim')}>{erroLocal}</div>}

      {dados.apenasReleitura && faltando === 0 && (
        <div style={s.aviso('atencao')}>
          Só a <strong>releitura</strong> foi conferida — o corpo bate com o <code>.sql</code>. Isso
          ainda não diz que elas executam nem que devolvem dado. Use <em>Conferir de verdade</em>
          {' '}depois de uma cópia de base: é esse passo que teria encurtado as duas perdas.
        </div>
      )}

      <div style={{ ...s.cartao, marginTop: '1rem' }}>
        <h3 style={s.h3}>Estado das seis</h3>
        <table style={{ ...s.tabela, marginTop: '.6rem' }}>
          <thead>
            <tr>
              <th style={s.th}>Sentença</th>
              <th style={s.th}>Situação</th>
              <th style={s.th}>Releitura</th>
              <th style={s.th}>Execução</th>
              <th style={s.th}>Volume</th>
            </tr>
          </thead>
          <tbody>
            {dados.itens.map((i) => {
              const sit = situacao(i);
              return (
                <tr key={i.codigo}>
                  <td style={{ ...s.td, fontFamily: 'ui-monospace, monospace' }}>{i.codigo}</td>
                  <td style={s.td}>
                    <span style={s.selo(sit.tom)}>{sit.rotulo}</span>
                  </td>
                  <td style={{ ...s.td, color: i.releitura.ok ? cor.texto : cor.ruim }}>
                    {i.releitura.detalhe}
                  </td>
                  <td style={{ ...s.td, color: i.execucao.ok ? cor.texto : cor.fraco }}>
                    {i.execucao.detalhe}
                    {/* Aviso, não reprovação: coluna ausente na resposta pode ser
                        coluna sempre nula. Quem decide a causa é a checagem de
                        flags, na releitura. */}
                    {i.aviso && (
                      <div style={{ color: cor.atencao, marginTop: '.2rem' }}>{i.aviso}</div>
                    )}
                  </td>
                  <td style={{ ...s.td, color: i.volume.ok ? cor.texto : cor.fraco }}>
                    {i.volume.detalhe}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ ...s.cartao, marginTop: '1rem' }}>
        <h3 style={s.h3}>Carga das Sentenças no TOTVS</h3>
        <p style={{ ...s.fraco, margin: '.3rem 0 .6rem' }}>
          Envia ao RM, por <code>SaveRecord</code>, cada Sentença que estiver faltando ou divergindo
          — o corpo vem do <code>.sql</code> do repositório e os metadados do{' '}
          <code>sentencas.manifesto.json</code>. O que já confere não é reenviado, então clicar duas
          vezes não faz nada duas vezes. <strong>As filas ficam pausadas enquanto isso roda</strong>{' '}
          e voltam no fim, para que nenhum job leia o RM no meio da troca.
        </p>

        {!confirmando ? (
          <button
            style={{ ...s.botao, opacity: faltando > 0 ? 1 : 0.6 }}
            onClick={() => setConfirmando(true)}
            disabled={carregando}
          >
            {faltando > 0 ? `Enviar ${faltando} Sentença(s) ao TOTVS` : 'Enviar assim mesmo'}
          </button>
        ) : (
          <div style={s.linha}>
            <input
              style={{ ...s.botao, cursor: 'text', minWidth: 280 }}
              placeholder="motivo (vai para a auditoria)"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
            />
            <button style={s.botao} onClick={() => void restaurar()} disabled={carregando}>
              {carregando ? 'Gravando e conferindo…' : 'Confirmar carga'}
            </button>
            <button style={s.botao} onClick={() => setConfirmando(false)} disabled={carregando}>
              Cancelar
            </button>
          </div>
        )}
      </div>

      {carga && (
        <div style={{ ...s.cartao, marginTop: '1rem' }}>
          <h3 style={s.h3}>Resultado da última carga</h3>
          <div style={{ ...s.linha, marginTop: '.5rem' }}>
            <span style={s.selo(carga.falharam === 0 ? 'bom' : 'ruim')}>
              {carga.restauradas} de {carga.pedidas} conferindo
            </span>
            <span style={s.fraco}>
              {carga.gravadas} enviada(s) ao RM · {carga.falharam} com problema
            </span>
          </div>

          {carga.itens.some((i) => i.desconhecido) && (
            <div style={s.aviso('atencao')}>
              Alguma gravação deu <strong>timeout</strong>. Timeout não é falha: a escrita pode ter
              acontecido. Vale o que a releitura diz abaixo, não o que o envio respondeu.
            </div>
          )}

          <table style={{ ...s.tabela, marginTop: '.6rem' }}>
            <thead>
              <tr>
                <th style={s.th}>Sentença</th>
                <th style={s.th}>Enviada</th>
                <th style={s.th}>Passou nas três?</th>
                <th style={s.th}>Onde reprovou</th>
                <th style={s.th}>Linhas</th>
              </tr>
            </thead>
            <tbody>
              {carga.itens.map((i) => (
                <tr key={i.codigo}>
                  <td style={{ ...s.td, fontFamily: 'ui-monospace, monospace' }}>{i.codigo}</td>
                  <td style={s.td}>{i.gravou ? 'sim' : 'não — já conferia'}</td>
                  <td style={s.td}>
                    <span style={s.selo(i.confere ? 'bom' : 'ruim')}>{i.confere ? 'sim' : 'não'}</span>
                  </td>
                  <td style={{ ...s.td, color: i.confere ? cor.fraco : cor.ruim }}>
                    {i.confere ? '—' : (i.reprovouEm ?? 'desconhecido')}
                  </td>
                  <td style={s.td}>{i.volume.linhas ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* O aviso que não cabe em nenhuma camada: restaurar as Sentenças não
              conserta o de-para, e o estrago dele é silencioso. */}
          {carga.aindaFalta && <div style={s.aviso('atencao')}>{carga.aindaFalta}</div>}
        </div>
      )}
    </>
  );
}
