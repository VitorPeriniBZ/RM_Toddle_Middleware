import { useEffect, useState } from 'react';
import { api, ApiError, type Mapeamento, type Proposta, type PropostaPendente } from '../api';
import { cor, quando, s } from '../estilos';

/**
 * O DE-PARA: ler, diagnosticar, PROPOR.
 *
 * ─── POR QUE NÃO EXISTE BOTÃO DE SALVAR AQUI ────────────────────────────────
 *
 * Um vínculo errado não é erro de tela: é nota ou falta gravada na turma, no
 * aluno ou na etapa errada de um registro acadêmico que já tem ~10 mil notas e
 * 14,6 mil faltas lançadas à mão. E o `configVersion`, que recusa job montado sob
 * outra configuração, não protege contra isso — mapeamento é dado, não
 * configuração.
 *
 * Então mudar vínculo é uma PROPOSTA, e aplicar é um segundo passo com o diff à
 * vista e o snapshot revalidado. Para um dev solo isso não é controle de duas
 * mãos — é o que pega o dedo errado, que é a razão de o controle existir.
 *
 * ─── E NÃO EXISTE APAGAR ────────────────────────────────────────────────────
 *
 * O `toddle_id` guardado no de-para é o único caminho de volta para um registro
 * arquivado no Toddle (o GET /students não devolve arquivado, nem por sourceId).
 * Apagar 186 linhas em 31/07/2026 destruiu exatamente esse handle. A migration
 * 018 passou a recusar DELETE no banco, embaixo desta tela.
 */

/** Só estes têm verificação de órfão confiável. O motivo está no servidor, e é sério. */
const TIPOS_COM_ORFAO = ['YEAR_GROUP', 'COURSE'] as const;

export function DePara({ aoErrar }: { aoErrar: (e: unknown) => void }) {
  const [q, setQ] = useState('');
  const [achados, setAchados] = useState<Mapeamento[] | null>(null);
  const [duplicatas, setDuplicatas] = useState<Array<{ entityType: string; toddleId: string; rmCodes: string[] }> | null>(null);
  const [orfaos, setOrfaos] = useState<{ total: number; itens: Mapeamento[]; fonte: string } | null>(null);
  const [tipoOrfao, setTipoOrfao] = useState<string>('YEAR_GROUP');
  const [curriculos, setCurriculos] = useState<Array<{ id: string; name?: string }>>([]);
  const [curriculo, setCurriculo] = useState('');
  const [proposta, setProposta] = useState<Partial<Proposta> | null>(null);
  const [erroLocal, setErroLocal] = useState<string | null>(null);

  // Currículos vêm da API para a tela não pedir que alguém digite um id de cor.
  // Digitar id à mão onde os dois currículos têm year groups de nomes duplicados
  // é o caminho mais curto para auditar a escada errada e concluir que está tudo
  // bem.
  useEffect(() => {
    api.curriculos().then((c) => {
      setCurriculos(c.itens);
      if (c.itens[0]) setCurriculo(c.itens[0].id);
    }).catch(() => undefined);
  }, []);

  async function buscar(): Promise<void> {
    setErroLocal(null);
    try {
      setAchados((await api.buscarMapeamentos(q.trim())).itens);
    } catch (e) {
      setErroLocal(e instanceof ApiError ? e.message : String(e));
    }
  }

  async function verOrfaos(): Promise<void> {
    setErroLocal(null);
    setOrfaos(null);
    try {
      setOrfaos(await api.orfaos(tipoOrfao, tipoOrfao === 'YEAR_GROUP' ? curriculo : undefined));
    } catch (e) {
      setErroLocal(e instanceof ApiError ? e.message : String(e));
    }
  }

  return (
    <>
      {/* A busca é a ação principal desta aba — fica num cartão, não solta no
          fluxo do texto, para ser a primeira coisa que a mão encontra. */}
      <div style={{ ...s.cartao, marginTop: '1rem' }}>
        <h3 style={s.h3}>Buscar vínculo</h3>
        <p style={{ ...s.fraco, margin: '.3rem 0 .6rem' }}>
          Por código do RM ou por id do Toddle — os dois lados, porque metade das perguntas chega
          pelo id de lá. Sem nomes: a busca é por código, de propósito.
        </p>
        <div style={s.linha}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && q.trim().length >= 2) void buscar(); }}
            placeholder="RA, código ou id do Toddle"
            style={{ ...s.campo, width: 260 }}
          />
          <button style={s.botao} onClick={() => void buscar()} disabled={q.trim().length < 2}>Buscar</button>
          <button style={s.botao} onClick={() => setProposta({ forma: 'vincular' })}>Propor vínculo novo</button>
        </div>
        <p style={{ ...s.fraco, margin: '.5rem 0 0' }}>
          O <code style={s.mono}>rm_code</code> de <code style={s.mono}>COURSE</code> é composto:{' '}
          <code style={s.mono}>CODPERLET:CODTURMA:CODDISC</code>. Não é mais o IDTURMADISC — identity
          é renumerado por cópia de base.
        </p>
      </div>

      {erroLocal && <div style={s.aviso('ruim')}>{erroLocal}</div>}

      {achados && (
        <table style={{ ...s.tabela, marginTop: '.7rem' }}>
          <thead>
            <tr>
              <th style={s.th}>tipo</th><th style={s.th}>rm_code</th><th style={s.th}>toddle_id</th>
              <th style={s.th}>estado</th><th style={s.th}>currículo</th><th style={s.th} />
            </tr>
          </thead>
          <tbody>
            {achados.length === 0 && (
              <tr><td style={s.td} colSpan={6}><span style={s.fraco}>nada encontrado</span></td></tr>
            )}
            {achados.map((m) => (
              <tr key={m.entityType + m.rmCode}>
                <td style={s.td}>{m.entityType}</td>
                <td style={{ ...s.td, ...s.mono }}>{m.rmCode}</td>
                <td style={{ ...s.td, ...s.mono }}>{m.toddleId}</td>
                <td style={s.td}>
                  <span style={s.selo(m.state === 'active' ? 'bom' : 'neutro')}>{m.state}</span>
                </td>
                <td style={{ ...s.td, ...s.mono }}>{m.curriculumId ?? '—'}</td>
                <td style={s.td}>
                  <button
                    style={s.botao}
                    onClick={() => setProposta({
                      forma: 'revincular', entityType: m.entityType, rmCode: m.rmCode,
                      curriculumId: m.curriculumId ?? undefined,
                    })}
                  >
                    Propor mudança
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {proposta && (
        <FormularioDeProposta
          inicial={proposta}
          curriculos={curriculos}
          aoFechar={() => setProposta(null)}
          aoErrar={aoErrar}
        />
      )}

      <PropostasPendentes aoErrar={aoErrar} />

      <h2 style={s.h2}>Diagnóstico</h2>
      <div style={s.linha}>
        <button
          style={s.botao}
          onClick={() => { void api.duplicatas().then((d) => setDuplicatas(d.itens)).catch(aoErrar); }}
        >
          Ver duplicatas
        </button>
        <select value={tipoOrfao} onChange={(e) => setTipoOrfao(e.target.value)} style={s.campo}>
          {TIPOS_COM_ORFAO.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {tipoOrfao === 'YEAR_GROUP' && (
          <select value={curriculo} onChange={(e) => setCurriculo(e.target.value)} style={s.campo}>
            {curriculos.map((c) => <option key={c.id} value={c.id}>{c.name ?? c.id}</option>)}
          </select>
        )}
        <button style={s.botao} onClick={() => void verOrfaos()}>Ver órfãos</button>
      </div>
      <p style={s.fraco}>
        Órfão só é verificável para year group e turma. Para aluno, professor e responsável, "a API não
        devolveu" NÃO significa "não existe" — o Toddle não devolve registro arquivado, e tratar essa
        ausência como órfão foi o que destruiu 186 handles em 31/07/2026.
      </p>

      {duplicatas && (
        <div style={s.cartao}>
          <h3 style={s.h3}>{duplicatas.length} toddle_id com mais de um rm_code</h3>
          <p style={s.fraco}>
            N para 1 é legítimo em year group e turma; para aluno, professor e responsável o banco já
            impede. Isto é uma lista para olhar, não uma lista de defeitos.
          </p>
          <table style={s.tabela}>
            <tbody>
              {duplicatas.map((d) => (
                <tr key={d.entityType + d.toddleId}>
                  <td style={s.td}>{d.entityType}</td>
                  <td style={{ ...s.td, ...s.mono }}>{d.toddleId}</td>
                  <td style={{ ...s.td, ...s.mono }}>{d.rmCodes.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {orfaos && (
        <div style={orfaos.total > 0 ? s.aviso('atencao') : s.aviso('bom')}>
          <strong>{orfaos.total} órfão(s)</strong> <span style={s.fraco}>(fonte: {orfaos.fonte})</span>
          <ul style={{ margin: '.4rem 0 0', paddingLeft: '1.2rem' }}>
            {orfaos.itens.map((m) => (
              <li key={m.rmCode} style={s.mono}>{m.rmCode} → {m.toddleId}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/**
 * Formulário da proposta.
 *
 * O `motivo` é obrigatório e o servidor exige 10 caracteres. Não é burocracia:
 * num `revincular` o valor anterior do vínculo sobrevive SÓ no evento de
 * auditoria, porque a chave única impede guardar a linha velha ao lado da nova.
 * O motivo é o que explica a mudança para quem ler depois.
 */
function FormularioDeProposta({
  inicial, curriculos, aoFechar, aoErrar,
}: {
  inicial: Partial<Proposta>;
  curriculos: Array<{ id: string; name?: string }>;
  aoFechar: () => void;
  aoErrar: (e: unknown) => void;
}) {
  const [p, setP] = useState<Partial<Proposta>>(inicial);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const campo = (k: keyof Proposta, rotulo: string, dica?: string) => (
    <div style={{ marginTop: '.4rem' }}>
      <label style={{ ...s.fraco, display: 'block' }}>{rotulo}</label>
      <input
        value={(p[k] as string) ?? ''}
        onChange={(e) => setP({ ...p, [k]: e.target.value })}
        style={{ ...s.campo, width: 340 }}
      />
      {dica && <div style={{ ...s.fraco, fontSize: '.78rem' }}>{dica}</div>}
    </div>
  );

  async function enviar(): Promise<void> {
    setOcupado(true);
    setErro(null);
    try {
      await api.propor(p as Proposta);
      aoFechar();
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : String(e));
      if (!(e instanceof ApiError)) aoErrar(e);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div style={{ ...s.cartao, borderColor: cor.atencao }}>
      <div style={{ ...s.linha, justifyContent: 'space-between' }}>
        <h3 style={s.h3}>Propor mudança de vínculo</h3>
        <button style={s.botao} onClick={aoFechar}>Cancelar</button>
      </div>

      <div style={{ ...s.linha, marginTop: '.5rem' }}>
        {(['vincular', 'revincular', 'arquivar'] as const).map((f) => (
          <button
            key={f}
            style={{ ...s.botao, fontWeight: p.forma === f ? 600 : 400 }}
            onClick={() => setP({ ...p, forma: f })}
          >
            {f}
          </button>
        ))}
      </div>

      {campo('entityType', 'entityType', 'ASSESSMENT usa chave composta IDTURMADISC:CODETAPA:CODPROVA')}
      {campo('rmCode', 'rm_code')}
      {p.forma !== 'arquivar' && campo('toddleId', 'toddle_id novo')}

      {p.entityType === 'YEAR_GROUP' && p.forma !== 'arquivar' && (
        <div style={{ marginTop: '.4rem' }}>
          <label style={{ ...s.fraco, display: 'block' }}>currículo (obrigatório em YEAR_GROUP)</label>
          <select
            value={p.curriculumId ?? ''}
            onChange={(e) => setP({ ...p, curriculumId: e.target.value })}
            style={s.campo}
          >
            <option value="">escolha…</option>
            {curriculos.map((c) => <option key={c.id} value={c.id}>{c.name ?? c.id}</option>)}
          </select>
          <div style={{ ...s.fraco, fontSize: '.78rem' }}>
            A organização tem dois currículos com year groups de nomes duplicados — o id sozinho não diz
            a qual escada pertence.
          </div>
        </div>
      )}

      <div style={{ marginTop: '.4rem' }}>
        <label style={{ ...s.fraco, display: 'block' }}>motivo (mín. 10 caracteres)</label>
        <textarea
          value={p.motivo ?? ''}
          onChange={(e) => setP({ ...p, motivo: e.target.value })}
          rows={2}
          style={{ ...s.campo, width: 340, fontFamily: 'inherit' }}
        />
      </div>

      {erro && <div style={s.aviso('ruim')}>{erro}</div>}

      <div style={{ ...s.linha, marginTop: '.6rem' }}>
        <button style={s.botao} onClick={() => void enviar()} disabled={ocupado}>
          {ocupado ? 'Enviando…' : 'Propor'}
        </button>
        <span style={s.fraco}>Nada é escrito agora. Alguém decide num segundo passo.</span>
      </div>
    </div>
  );
}

/** As propostas esperando decisão, com o diff que a pessoa tem de ler antes de aprovar. */
function PropostasPendentes({ aoErrar }: { aoErrar: (e: unknown) => void }) {
  const [itens, setItens] = useState<PropostaPendente[]>([]);
  const [erro, setErro] = useState<string | null>(null);

  async function carregar(): Promise<void> {
    try {
      setItens((await api.propostas()).itens);
    } catch (e) {
      aoErrar(e);
    }
  }
  useEffect(() => { void carregar(); }, []);

  async function decidir(id: string, decisao: 'approved' | 'rejected'): Promise<void> {
    const motivo = window.prompt(
      decisao === 'approved'
        ? 'Aprovar. O snapshot é revalidado antes de gravar — se a linha mudou, a aprovação perde validade. Motivo:'
        : 'Recusar. Motivo:',
      '',
    );
    if (motivo === null) return;
    setErro(null);
    try {
      await api.decidirProposta(id, decisao, motivo);
      await carregar();
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : String(e));
    }
  }

  if (itens.length === 0) return null;

  return (
    <>
      <h2 style={s.h2}>Propostas esperando decisão ({itens.length})</h2>
      {erro && <div style={s.aviso('ruim')}>{erro}</div>}
      {itens.map((it) => (
        <div key={it.operationId} style={{ ...s.cartao, borderColor: cor.atencao }}>
          <div style={s.linha}>
            <span style={s.selo('atencao')}>{it.proposta.forma}</span>
            <strong>{it.proposta.entityType}</strong>
            <span style={s.mono}>{it.proposta.rmCode}</span>
            <span style={s.fraco}>por {it.criadoPorQuem ?? 'desconhecido'} · {quando(it.criadoEm)}</span>
          </div>
          <table style={{ ...s.tabela, marginTop: '.5rem' }}>
            <tbody>
              <tr>
                <td style={{ ...s.td, ...s.fraco, width: 90 }}>antes</td>
                <td style={{ ...s.td, ...s.mono }}>
                  {it.snapshot ? `${it.snapshot.toddleId} (${it.snapshot.state})` : 'não existia'}
                </td>
              </tr>
              <tr>
                <td style={{ ...s.td, ...s.fraco }}>depois</td>
                <td style={{ ...s.td, ...s.mono }}>
                  {it.proposta.forma === 'arquivar' ? 'archived' : it.proposta.toddleId}
                  {it.proposta.curriculumId ? ` · currículo ${it.proposta.curriculumId}` : ''}
                </td>
              </tr>
              <tr>
                <td style={{ ...s.td, ...s.fraco }}>motivo</td>
                <td style={s.td}>{it.proposta.motivo}</td>
              </tr>
            </tbody>
          </table>
          <div style={{ ...s.linha, marginTop: '.6rem' }}>
            <button style={s.botao} onClick={() => void decidir(it.operationId, 'approved')}>Aprovar e aplicar</button>
            <button style={s.botao} onClick={() => void decidir(it.operationId, 'rejected')}>Recusar</button>
          </div>
        </div>
      ))}
    </>
  );
}
