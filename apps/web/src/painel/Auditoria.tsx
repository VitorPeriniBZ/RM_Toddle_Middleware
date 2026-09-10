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
      <h2 style={s.h2}>Auditoria ({eventos.length} eventos)</h2>
      <p style={s.fraco}>
        Append-only: a tabela recusa UPDATE, DELETE e TRUNCATE no banco (migration 017), não só por
        contrato. Correção se faz com um evento novo.
      </p>
      {eventos.length === 0 && (
        <p style={s.fraco}>
          Nada ainda. A trilha começa na primeira mudança feita pela tela.
        </p>
      )}
      <table style={s.tabela}>
        <thead>
          <tr>
            <th style={s.th}>quando</th><th style={s.th}>quem</th><th style={s.th}>ação</th>
            <th style={s.th}>alvo</th><th style={s.th}>antes → depois</th><th style={s.th}>motivo</th>
          </tr>
        </thead>
        <tbody>
          {eventos.map((e) => (
            <tr key={e.id}>
              <td style={{ ...s.td, whiteSpace: 'nowrap' }}>{quando(e.ocorridoEm)}</td>
              <td style={s.td}>{e.quem ?? e.ator}</td>
              <td style={{ ...s.td, ...s.mono }}>{e.acao}</td>
              <td style={{ ...s.td, ...s.mono }}>
                {e.entidade ? `${e.entidade}` : '—'}
                {e.entidadeId ? <><br />{e.entidadeId}</> : null}
              </td>
              <td style={{ ...s.td, ...s.mono, fontSize: '.78rem' }}>
                {resumir(e.antes)} → {resumir(e.depois)}
              </td>
              <td style={s.td}>{e.motivo ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** JSON curto: a tabela precisa caber, e o detalhe completo está no banco. */
function resumir(v: unknown): string {
  if (v === null || v === undefined) return '—';
  const txt = typeof v === 'string' ? v : JSON.stringify(v);
  return txt.length > 90 ? `${txt.slice(0, 90)}…` : txt;
}
