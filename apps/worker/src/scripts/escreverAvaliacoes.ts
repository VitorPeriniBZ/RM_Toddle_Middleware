import { configVersionDetalhe, logger } from '@rm-toddle/config';
import { pgPool } from '@rm-toddle/db';
import {
  sincronizarAvaliacoes,
  type RelatorioAvaliacoes,
} from '../services/sincronizarAvaliacoes';

/**
 * ESCREVE a nota de AVALIAÇÃO do Toddle no TOTVS RM — pela mão de alguém.
 *
 *   npm run escrever:avaliacoes
 *   npm run escrever:avaliacoes -- --turma 2026:EAVHS10IA:HS0001 --data-ref 2026-09-23
 *   npm run escrever:avaliacoes -- ... --executar
 *
 * ─── ESTE ARQUIVO É SÓ A CASCA ──────────────────────────────────────────────
 *
 * A orquestração mora em `services/sincronizarAvaliacoes.ts`, porque agora há
 * DOIS consumidores: este CLI e o job `term-grades.sync`. Aqui ficam apenas os
 * argumentos e o relatório para gente ler.
 *
 * O default continua sendo ENSAIO. `--executar` é uma palavra que alguém digita.
 *
 * ─── POR QUE ESTE CAMINHO, E NÃO O `escrever:notas` ────────────────────────
 *
 * `escrever:notas` escreve na nota da ETAPA, e o `EduNotaEtapaData` DESCARTA o
 * valor — medido em 09/09/2026, seis formatos, todos com `ok=true` e releitura
 * `0.0000`. A nota da etapa é calculada por fórmula (`CODFORMULANOTA='01_ETAPA'`).
 * A nota que se pode escrever é a da AVALIAÇÃO: `SProvas` + `SNotas`.
 */

interface Args {
  turma?: string;
  dataRef?: string;
  executar: boolean;
  quem?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const pega = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dataRef = pega('data-ref');
  if (dataRef !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(dataRef)) {
    throw new Error(`--data-ref inválida: ${dataRef}. Use YYYY-MM-DD.`);
  }
  return {
    turma: pega('turma'),
    dataRef,
    executar: argv.includes('--executar'),
    quem: pega('quem'),
  };
}

const p = (s = ''): void => {
  // eslint-disable-next-line no-console
  console.log(s);
};

function imprimir(r: RelatorioAvaliacoes, executar: boolean): void {
  p('');
  p('══════════════════════════════════════════════════════════════════');
  p(`  NOTA DE AVALIAÇÃO  Toddle -> RM   ${executar ? '*** ESCRITA ***' : '(ensaio)'}`);
  p('══════════════════════════════════════════════════════════════════');
  p(`  campus         CODFILIAL=${r.codFilial}   escopo ${r.turmasEmEscopo} turma-disciplina`);
  p(`  tipos elegíveis ${r.tiposElegiveis.join(', ')}`);
  p(`  data de ref.   ${r.dataRef}`);
  p(`  run            ${r.chaveRun}`);
  p('');
  p('── o que o Toddle tem ────────────────────────────────────────────');
  p(`  avaliações (assignments)        ${r.origem.avaliacoes}`);
  for (const [t, n] of Object.entries(r.origem.porTipo)) p(`      ${t.padEnd(28)} ${n}`);
  p(`  resultados lidos                ${r.origem.resultadosLidos}`);
  p(`  com nota numérica               ${r.origem.comNota}`);
  p(`  sem nota lançada                ${r.origem.semNota}`);
  p(`  só rubrica (sem número)         ${r.origem.soRubrica}`);
  p('');
  p('── o que o RM tem ────────────────────────────────────────────────');
  p(`  etapas de nota digitáveis       ${r.alvos.etapasDigitaveis}`);
  p(`  avaliações já cadastradas       ${r.alvos.provas}`);
  p(`  notas de avaliação existentes   ${r.alvos.notas}`);
  p('');
  p('── plano ─────────────────────────────────────────────────────────');
  p(`  projetáveis                     ${r.projecao.projetaveis}`);
  p(`  recusados na projeção           ${r.projecao.recusados}`);
  for (const [m, n] of Object.entries(r.projecao.porMotivo)) p(`      ${m.padEnd(28)} ${n}`);
  if (r.projecao.colisoes) {
    p(`  COLISÃO                         ${r.projecao.colisoes} chave(s) com dois valores`);
  }
  p('');
  for (const [v, n] of Object.entries(r.decisoes.porVeredito)) p(`      ${v.padEnd(28)} ${n}`);
  p(`  A ESCREVER                      ${r.decisoes.aEscrever}`);
  p(`  pendências                      ${r.decisoes.pendencias}`);
  p('');
  p(`  AVALIAÇÕES A CRIAR NO RM        ${r.provasACriar.length}   (isto é ESTRUTURA)`);
  for (const pr of r.provasACriar) {
    p(`      IDTURMADISC ${pr.idTurmaDisc} etapa ${pr.codEtapa} CODPROVA ${pr.codProva}  VALOR ${pr.valor}`);
    p(`         "${pr.descricao.slice(0, 70)}"`);
  }
  p('');
  p(`  datasets de nota                ${r.lotes.length}`);
  for (const l of r.lotes) {
    p(`      IDTURMADISC ${l.idTurmaDisc} etapa ${l.codEtapa} prova ${l.codProva}: ${l.linhas.length} nota(s)`);
    for (const n of l.linhas) p(`          RA ${n.ra}  nota ${n.nota}`);
  }
  p('');
  p(`  teto de volume                  ${r.volume.veredito}`);
  for (const m of r.volume.motivos) p(`      ${m}`);
  p('');
  p(`  fila de pendências (aberta)     ${r.filaAberta}   (${r.pendenciasAbertasNestaPassada} nesta passada)`);

  if (!r.escrita) {
    p('');
    switch (r.naoEscreveu) {
      case 'ensaio':
        p('  ENSAIO. Nada foi enviado ao RM. Use --executar para escrever.');
        break;
      case 'nada-a-escrever':
        p('  Nada a escrever.');
        break;
      case 'recusado-pelo-teto':
        p('  RECUSADO pelo teto de volume. Nada foi enviado — isto é para investigar.');
        break;
      case 'precisa-aprovacao':
        p('  PRECISA APROVAÇÃO. Pedido registrado, nada enviado.');
        p(`  Aprove com: npm run aprovar -- --chave ${r.chaveRun} --quem SEU_NOME`);
        break;
      default:
        p('  Nada foi enviado.');
    }
    p('');
    return;
  }

  const e = r.escrita;
  p('');
  p('── fase A: avaliações criadas ────────────────────────────────────');
  p(`  criadas                 ${e.provasCriadas}`);
  for (const f of e.provasQueFalharam) p(`  FALHOU ${f.chave}: ${f.resposta.slice(0, 160)}`);
  p('');
  p('── fase B: notas ─────────────────────────────────────────────────');
  p(`  enviadas                ${e.notasEnviadas}   (${e.chamadas} chamada(s))`);
  for (const f of e.recusadas) p(`  FALHOU ${f.chave}: ${f.resposta.slice(0, 160)}`);
  p('');
  p('── conferindo por leitura ────────────────────────────────────────');
  p(`  avaliações no RM        ${e.provasNoRm.antes} → ${e.provasNoRm.depois}`);
  p(`  notas de avaliação      ${e.notasNoRm.antes} → ${e.notasNoRm.depois}`);
  p(`  CONFERIDAS              ${e.conferidas}`);
  if (e.divergentes.length) {
    p(`  DIVERGENTES             ${e.divergentes.length}`);
    for (const d of e.divergentes.slice(0, 10)) {
      p(`      ${d.chave} enviado ${d.enviado} no RM ${d.noRm}`);
    }
  }
  p('');
}

async function main(): Promise<void> {
  const args = parseArgs();
  logger.info(
    { ...configVersionDetalhe(), executar: args.executar },
    args.executar ? 'ESCRITA de nota de avaliação no RM' : 'Ensaio (nada será enviado)',
  );

  const r = await sincronizarAvaliacoes({
    executar: args.executar,
    turma: args.turma,
    dataRef: args.dataRef,
    quem: args.quem,
  });
  imprimir(r, args.executar);

  const falhou =
    r.naoEscreveu === 'recusado-pelo-teto' ||
    (r.escrita &&
      (r.escrita.divergentes.length > 0 ||
        r.escrita.recusadas.length > 0 ||
        r.escrita.provasQueFalharam.length > 0));

  await pgPool.end();
  if (falhou) process.exitCode = 1;
}

main().catch(async (err) => {
  logger.error({ err: (err as Error).message }, 'Escrita de nota de avaliação falhou');
  // eslint-disable-next-line no-console
  console.error(err);
  await pgPool.end().catch(() => undefined);
  process.exitCode = 1;
});
