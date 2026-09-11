import { useEffect, useState } from 'react';
import { api, type EventoDeAuditoria } from '../api';
import { quando, s } from '../estilos';

/**
 * A trilha de auditoria, na tela.
 *
 * ─── POR QUE ELA APARECE AQUI, E NÃO SÓ NO BANCO ────────────────────────────
 *
 * `audit_event` existe desde a migration 006 e ficou VAZIA por meses. Agora toda
 * mudança de agenda e todo vínculo alterado gravam nela, na mesma transação da
 * mudança — se a auditoria falhar, a mudança falha.
 *
 * Mostrar aqui não é enfeite: uma auditoria que só existe para quem abre o psql
 * não muda o comportamento de ninguém. E num `revincular` este é o único lugar
 * onde o vínculo ANTERIOR continua existindo — a chave única do de-para impede
 * guardar a linha velha ao lado da nova.
 */
export function Auditoria({ aoErrar }: { aoErrar: (e: unknown) => void }) {
  const [eventos, setEventos] = useState<EventoDeAuditoria[] | null>(null);

  useEffect(() => {
    api.auditoria(60).then((r) => setEventos(r.eventos)).catch(aoErrar);
  }, []);

  if (!eventos) return <p style={s.fraco}>Lendo a trilha…</p>;

  return (
    <>
      <div style={s.barra}>
        <div>
          <div style={s.kpiNumero('neutro')}>{eventos.length}</div>
          <div style={s.kpiRotulo}>eventos</div>
        </div>
        <span style={{ ...s.fraco, maxWidth: 520 }}>
          Append-only: a tabela recusa UPDATE, DELETE e TRUNCATE no banco (migration 017), não só por
          contrato. Correção se faz com um evento novo.
        </span>
      </div>

      {eventos.length === 0 ? (
        <p style={{ ...s.fraco, marginTop: '1rem' }}>
          Nada ainda. A trilha começa na primeira mudança feita pela tela.
        </p>
      ) : (
        <table style={{ ...s.tabela, marginTop: '1rem' }}>
          <thead>
            <tr>
              <th style={s.th}>quando</th>
              <th style={s.th}>quem</th>
              <th style={s.th}>o quê</th>
              <th style={s.th}>motivo</th>
            </tr>
          </thead>
          <tbody>
            {eventos.map((e) => (
              <tr key={e.id}>
                <td style={{ ...s.td, whiteSpace: 'nowrap', width: 110 }}>{quando(e.ocorridoEm)}</td>
                <td style={{ ...s.td, width: 170, wordBreak: 'break-word' }}>{e.quem ?? e.ator}</td>
                <td style={s.td}>
                  {/* Ação e alvo juntos: eram duas colunas monoespaçadas que
                      espremiam o motivo, que é a única parte escrita por gente. */}
                  <code style={s.mono}>{e.acao}</code>
                  {e.entidade && (
                    <span style={s.fraco}>
                      {' '}· {e.entidade}
                      {e.entidadeId ? ` ${e.entidadeId}` : ''}
                    </span>
                  )}
                  {(e.antes !== undefined && e.antes !== null) || (e.depois !== undefined && e.depois !== null) ? (
                    <details>
                      <summary style={{ ...s.resumoDetalhe, marginTop: '.2rem' }}>antes → depois</summary>
                      <div style={s.blocoTecnico}>
                        {`antes:  ${completo(e.antes)}\ndepois: ${completo(e.depois)}`}
                      </div>
                    </details>
                  ) : null}
                </td>
                <td style={s.td}>{e.motivo ?? <span style={s.fraco}>—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/**
 * O valor inteiro, dentro do detalhe recolhido.
 *
 * Antes era truncado em 90 caracteres direto na célula: o JSON espremia a tabela
 * E ficava incompleto, então não servia nem para ler rápido nem para investigar.
 * Recolhido, cabe inteiro.
 */
function completo(v: unknown): string {
  if (v === null || v === undefined) return '—';
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}
