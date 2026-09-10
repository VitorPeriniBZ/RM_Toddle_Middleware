import { configVersionDetalhe, env, logger } from '@rm-toddle/config';
import { pgPool } from '@rm-toddle/db';
import { sincronizarNotas, type RelatorioNotas } from '../services/sincronizarNotas';

/**
 * ESCREVE a nota de etapa do Toddle no TOTVS RM, sob comando.
 *
 *   npm run escrever:notas
 *   npm run escrever:notas -- --turma 1266
 *   npm run escrever:notas -- --etapa 2 --data-ref 2026-10-01
 *   npm run escrever:notas -- ... --executar
 *
 * ─── SEM `--executar`, NADA É ENVIADO ───────────────────────────────────────
 *
 * O default é ensaio. O `SaveRecord` é upsert e responde HTTP 200 mesmo
 * recusando, e este caminho altera a base acadêmica legal de uma escola.
 *
 * ─── O PIPELINE NÃO MORA AQUI ───────────────────────────────────────────────
 *
 * Está em `services/sincronizarNotas.ts`, compartilhado com o job agendado
 * (`termGrades.processor.ts`). Este arquivo só traduz argumentos e imprime o
 * relatório: duas cópias do caminho de escrita divergiriam, e a que divergisse
 * seria a automática — a que ninguém lê o output.
 */

interface Args {
  turma?: string;
  etapa?: string;
  criterio?: string;
  dataRef?: string;
  executar: boolean;
  ignorarLiberacao: boolean;
  exigirLiberacao: boolean;
  quem?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const pega = (nome: string): string | undefined => {
    const i = argv.indexOf(`--${nome}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dataRef = pega('data-ref');
  if (dataRef !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(dataRef)) {
    throw new Error(`--data-ref inválida: ${dataRef}. Use YYYY-MM-DD.`);
  }
  const etapa = pega('etapa');
  if (etapa !== undefined && !/^[0-9]+$/.test(etapa)) {
    throw new Error(`--etapa espera o CODETAPA numérico do RM, recebeu ${JSON.stringify(etapa)}.`);
  }
  return {
    turma: pega('turma'),
    etapa,
    criterio: pega('criterio'),
    dataRef,
    executar: argv.includes('--executar'),
    ignorarLiberacao: argv.includes('--ignorar-liberacao'),
    exigirLiberacao: argv.includes('--exigir-liberacao'),
    quem: pega('quem'),
  };
}

const p = (s = ''): void => {
  // eslint-disable-next-line no-console
  console.log(s);
};

function imprimir(r: RelatorioNotas, executar: boolean): void {
  p('');
  p('══════════════════════════════════════════════════════════════════');
  p(`  NOTA Toddle -> RM   ${executar ? '*** ESCRITA ***' : '(ensaio)'}`);
  p('══════════════════════════════════════════════════════════════════');
  p(`  campus         CODFILIAL=${r.codFilial}`);
  p(`  escopo         ${r.turmasEmEscopo} turma-disciplina, ${r.alunosEmEscopo} alunos`);
  p(`  critério       ${r.criterio}`);
  p(`  data de ref.   ${r.dataRef}   (teste de janela da D2)`);
  p(`  configVersion  ${r.configVersion}`);
  p(`  run            ${r.chaveRun}`);
  p('');
  p('── o que o Toddle tem ────────────────────────────────────────────');
  p(`  alunos lidos                    ${r.origem.alunos}`);
  p(`  alunos COM nota                 ${r.origem.alunosComNota}`);
  p(`  notas achatadas                 ${r.origem.notas.length}`);
  for (const [c, n] of Object.entries(r.origem.porCriterio)) p(`      ${c.padEnd(28)} ${n}`);
  p('');
  p('── etapas de nota no RM ──────────────────────────────────────────');
  p(`  etapas digitáveis               ${r.alvos.etapasDigitaveis}`);
  for (const v of r.alvos.vigencias) p(`      ${v}`);
  p('');
  p('── plano ─────────────────────────────────────────────────────────');
  p(`  projetáveis                     ${r.projecao.projetados.length}`);
  p(`  recusados na projeção           ${r.projecao.recusados.length}`);
  for (const [motivo, n] of Object.entries(r.projecao.porMotivo)) p(`      ${motivo.padEnd(28)} ${n}`);
  if (r.projecao.colisoes.length) {
    p('');
    p(`  COLISÃO: ${r.projecao.colisoes.length} chave(s) com duas notas diferentes do Toddle`);
    for (const c of r.projecao.colisoes.slice(0, 5)) p(`      ${c}`);
  }
  p('');
  for (const [veredito, n] of Object.entries(r.decisoes.porVeredito)) p(`      ${veredito.padEnd(28)} ${n}`);
  p(`  A ESCREVER                      ${r.decisoes.aEscrever}`);
  p(`  pendências (precisam de humano) ${r.decisoes.pendencias}`);
  p('');
  p(`  datasets                        ${r.lotes.length}`);
  for (const l of r.lotes) {
    p(`      IDTURMADISC ${l.idTurmaDisc}  etapa ${l.codEtapa}  ${l.linhas.length} nota(s)`);
  }
  if (r.lotes.length === 1 && r.lotes[0].linhas.length <= 3) {
    p('');
    p('── XML que seria enviado ─────────────────────────────────────────');
    for (const linha of r.lotes[0].xml.split('\n')) p(`  ${linha}`);
  }
  p('');
  p(`  teto de volume                  ${r.volume.veredito}`);
  for (const m of r.volume.motivos) p(`      ${m}`);
  p('');
  p(`  fila de pendências (aberta)     ${r.filaAberta}   (${r.pendenciasAbertasNestaPassada} nesta passada)`);
  for (const q of r.perguntasEmAberto) p(`      ${q.chave.padEnd(30)} ${q.notas} nota(s) presas`);

  if (r.naoEscreveu) {
    p('');
    const razao: Record<string, string> = {
      ensaio: 'ENSAIO. Nada foi enviado ao RM. Use --executar para escrever.',
      'nada-a-escrever': 'Nada a escrever. Encerrando sem tocar o RM.',
      'recusado-pelo-teto':
        'RECUSADO pelo teto de volume. Nada foi enviado.\n' +
        '  Isto não é para ser aprovado — é para ser investigado. Confira o de-para e o escopo.',
      'precisa-aprovacao':
        'PRECISA APROVAÇÃO. O pedido foi registrado e nada foi enviado.\n' +
        `  Aprove com: npm run aprovar -- --chave ${r.chaveRun} --quem SEU_NOME`,
      desligado: 'NOTA_SYNC_ATIVO=false. A via de nota está desligada para este tenant.',
    };
    p(`  ${razao[r.naoEscreveu]}`);
    p('');
    return;
  }

  const e = r.escrita;
  if (!e) return;
  p('');
  p('── conferindo por leitura ────────────────────────────────────────');
  p(`  notas na leitura        ${e.notasNoRmAntes} → ${e.notasNoRmDepois}`);
  p(`  enviadas                ${e.enviadas}   recusadas ${e.recusadas.length}   sem resposta ${e.desconhecidas.length}`);
  p(`  envios ao RM            ${e.chamadas}`);
  p(`  CONFERIDAS              ${e.conferidas}/${e.enviadas}   (releitura achou a chave E o valor)`);
  if (e.divergentes.length) {
    p(`  DIVERGENTES             ${e.divergentes.length}   a linha existe com OUTRO valor — investigar`);
    for (const d of e.divergentes.slice(0, 10)) p(`      ${d.chave}  enviado ${d.enviado}  no RM ${d.noRm}`);
  }
  if (e.ausentes.length) {
    p(`  AUSENTES                ${e.ausentes.length}   o RM disse OK e a linha não está lá`);
    for (const a of e.ausentes.slice(0, 10)) p(`      ${a}`);
  }
  if (e.recusadas.length) {
    p('');
    p(`  ${e.recusadas.length} nota(s) o RM recusou individualmente — viraram pendência.`);
    p('      `npm run pendencias` mostra a resposta do RM em cada uma.');
  }
  p('');
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.ignorarLiberacao && args.exigirLiberacao) {
    throw new Error('--ignorar-liberacao e --exigir-liberacao são contraditórios. Escolha um.');
  }

  logger.info(
    { ...configVersionDetalhe(), executar: args.executar, notaSyncAtivo: env.NOTA_SYNC_ATIVO },
    args.executar ? 'ESCRITA de nota no RM' : 'Ensaio de escrita de nota (nada será enviado)',
  );

  const relatorio = await sincronizarNotas({
    executar: args.executar,
    turma: args.turma,
    etapa: args.etapa,
    criterio: args.criterio,
    dataRef: args.dataRef,
    exigirEtapaLiberada: args.exigirLiberacao ? true : args.ignorarLiberacao ? false : undefined,
    quem: args.quem,
  });

  imprimir(relatorio, args.executar);

  const e = relatorio.escrita;
  const falhou = Boolean(e && (e.divergentes.length || e.ausentes.length || e.desconhecidas.length));
  await pgPool.end();
  if (falhou || relatorio.naoEscreveu === 'recusado-pelo-teto') process.exitCode = 1;
}

main().catch(async (err) => {
  logger.error({ err: (err as Error).message }, 'Escrita de nota falhou');
  // eslint-disable-next-line no-console
  console.error(err);
  await pgPool.end().catch(() => undefined);
  process.exitCode = 1;
});
