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
 *   cadastro  — o corpo no RM é caractere a caractere igual ao `.sql`, E as
 *               flags `SEMSEG*` batem com o manifesto (são elas que fazem o RM
 *               remover coluna ou linha sem avisar)
 *   execução  — a Sentença roda sem o RM recusar
 *   retorno   — voltou mais que zero linha
 *
 * ─── O QUE NÃO SE MEDE AQUI ────────────────────────────────────────────────
 *
 * Não existe comparação de volume contra número esperado. A base é um sistema
 * vivo — matrícula entra, nota é lançada todo dia — e qualquer literal de
 * referência diverge do real na primeira semana, acusando diferença justamente
 * quando a escola está funcionando. O invariante que não caduca é "mais que
 * zero"; o resto é o número do dia, mostrado sem julgamento.
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
  if (!i.releitura.ok) return { rotulo: 'cadastro diverge', tom: TOM.falta };
  if (!i.verificacaoCompleta) return { rotulo: 'cadastro ok, execução não testada', tom: TOM.parcial };
  if (i.confere) return { rotulo: 'cadastro e execução ok', tom: TOM.ok };
  return { rotulo: `falhou em ${i.reprovouEm}`, tom: TOM.falta };
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

  /**
   * Cria o que falta e só então executa — nessa ordem, e as duas coisas.
   *
   * O botão antes só executava. Com 4 das 6 ausentes do RM, ele dizia
   * "Executar as seis" e executava duas: as quatro que faltavam não têm o que
   * executar, e a tela terminava verde do lado de quem sobrou. Criar antes é o
   * que faz o rótulo ser verdade.
   *
   * A carga só é disparada quando há o que criar. Ela é idempotente (o que já
   * confere não é reenviado), mas pausa as filas enquanto roda — e pausar as
   * filas para não gravar nada é custo sem contrapartida.
   */
  async function criarEExecutar(): Promise<void> {
    setCarregando(true);
    setErroLocal(null);
    try {
      if ((dados?.ausentes ?? 0) + (dados?.divergentes ?? 0) > 0) {
        setCarga(await api.restaurarSentencas('criar e executar pelo Plano de Controle'));
      }
      // Vale o que a execução diz agora, não o que a carga respondeu: o
      // timeout de gravação é indistinguível de falha, e só a releitura decide.
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
            {carregando ? 'Lendo…' : 'Atualizar'}
          </button>
          {/* Nomeado pelo que faz, e agora faz as duas coisas. "Conferir de
              verdade" declarava a outra checagem como de mentira; "Executar as
              seis" prometia seis e entregava quantas existissem. Este grava o
              que falta e executa — e o rótulo diz as duas. */}
          <button style={s.botao} onClick={() => void criarEExecutar()} disabled={carregando}>
            {carregando ? 'Criando e executando…' : 'Criar e Executar'}
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
          Foi lido o <strong>cadastro</strong>: o corpo bate com o <code>.sql</code> e as flags de
          segurança conferem. Isso ainda não diz que elas executam nem que devolvem dado — para
          isso, <em>Criar e Executar</em>. É esse passo que teria encurtado as duas perdas.
        </div>
      )}

      <div style={{ ...s.cartao, marginTop: '1rem' }}>
        <h3 style={s.h3}>Estado das seis</h3>
        <table style={{ ...s.tabela, marginTop: '.6rem' }}>
          <thead>
            <tr>
              <th style={s.th}>Sentença</th>
              <th style={s.th}>Situação</th>
              <th style={s.th}>Cadastro</th>
              <th style={s.th}>Execução</th>
              <th style={s.th}>Retorno</th>
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

        {/* A nota de rodapé existe UMA vez. Antes, esta explicação vinha repetida
            dentro de cada linha da coluna Execução — três linhas de texto
            idêntico em cinco das seis Sentenças. Texto que se repete a cada
            linha deixa de ser lido, e leva junto a informação que só ele tinha:
            QUAL coluna veio vazia. */}
        {dados.itens.some((i) => i.aviso) && (
          <p style={{ ...s.fraco, marginTop: '.7rem' }}>
            <strong>Sobre as colunas sem valor:</strong> com as flags de segurança conferindo, o
            provável é coluna sempre nula no RM — e não coluna removida. Vale conferir se alguma
            delas alimenta o Toddle: nula chega no middleware como <code>undefined</code>, que é
            indistinguível de &ldquo;o RM não tem esse dado&rdquo;.
          </p>
        )}
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
