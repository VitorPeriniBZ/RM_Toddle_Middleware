import { logger, tenantConfig } from '@rm-toddle/config';
import { idMappingRepository, pgPool } from '@rm-toddle/db';
import {
  fetchFrequenciaFromRm,
  indexaFaltasPorChave,
  RmAttendanceTargets,
  chaveNaturalRm,
  type LinhaFrequencia,
} from '@rm-toddle/domain';
import { wsDataServerClient } from '@rm-toddle/integrations';

const cfg = tenantConfig;

/**
 * Lança UMA falta no RM — o primeiro `SaveRecord` de verdade deste projeto.
 *
 *   npm run lancar:falta                       # ensaio: escolhe alvo e mostra o XML
 *   npm run lancar:falta -- --executar         # escreve
 *   npm run lancar:falta -- --executar --remover   # tenta desfazer com PRESENCA='P'
 *
 * ─── POR QUE UM REGISTRO, E NÃO UM LOTE ─────────────────────────────────────
 *
 * Três perguntas em aberto que só a escrita responde, e nenhuma precisa de mais
 * de uma linha:
 *
 *   1. o RM aceita o dataset que `montaLotes` produz?
 *   2. `AULASDADAS` omitido é aceito? (§4 e §9.3 de EduFrequenciaDiariaWSData.md —
 *      "opcional no XSD não é opcional na regra de negócio", e é a primeira coisa
 *      que aquele documento manda testar)
 *   3. `PRESENCA='P'` REMOVE o registro? Isso está afirmado num comentário como
 *      inferência ("o SFREQUENCIA guarda só ausência, por isso 'P' remove"),
 *      **nunca foi medido**, e é o único desfazer que temos.
 *
 * Um lote responderia as mesmas três e deixaria N linhas falsas em vez de uma.
 *
 * ─── O ALVO É ESCOLHIDO PARA MINIMIZAR DANO ─────────────────────────────────
 *
 * O script procura uma aula onde o aluno NÃO tem falta. Isso é deliberado, e a
 * alternativa foi descartada: reescrever uma falta existente com valores
 * idênticos pareceria mais seguro (não muda o dado), mas estamparia
 * `RECMODIFIEDBY` com a conta da integração sobre o lançamento de um professor —
 * corrompendo exatamente o sinal de autoria em que toda a camada de segurança se
 * apoia. Criar uma linha nova não pisa em trabalho de ninguém.
 *
 * O que fica: uma falta falsa, de um aluno, numa aula. Identificável como nossa
 * (`CRIADO_POR` = conta da integração) e removível pela tela do RM se o `'P'` não
 * funcionar. É o menor dano possível que ainda testa uma escrita.
 */

interface Alvo {
  idTurmaDisc: string;
  ra: string;
  data: string;
  idHorarioTurma: string;
  codEtapa: string;
  horaInicial: string;
  codTurma?: string;
  /** Ecoado de volta ao RM. Ver a nota em `RmEtapaFalta.aulasDadas`. */
  aulasDadas: string | null;
}

/** O dataset do XSD, com UMA linha. `AULASDADAS` omitido — é o que se testa. */
function montaXml(alvo: Alvo, presenca: string): string {
  const NS = 'http://tempuri.org/EduFrequenciaDiaria.xsd';
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<EduFrequenciaDiaria xmlns="${NS}">`,
    '  <PARAMS>',
    `    <CODCOLIGADA>${cfg.rm.escopo.coligada}</CODCOLIGADA>`,
    `    <IDTURMADISC>${alvo.idTurmaDisc}</IDTURMADISC>`,
    `    <CODETAPA>${alvo.codEtapa}</CODETAPA>`,
    // MEDIDO em 21/08/2026: sem isto o RM recusa com "O campo número de aulas
    // dadas deve ser preenchido". O valor é ECOADO do próprio RM, nunca
    // calculado — é o denominador dos 75% de reprovação por falta.
    ...(alvo.aulasDadas ? [`    <AULASDADAS>${alvo.aulasDadas}</AULASDADAS>`] : []),
    '  </PARAMS>',
    '  <AlunosFreq>',
    `    <CODCOLIGADA>${cfg.rm.escopo.coligada}</CODCOLIGADA>`,
    `    <RA>${alvo.ra}</RA>`,
    `    <IDTURMADISC>${alvo.idTurmaDisc}</IDTURMADISC>`,
    '  </AlunosFreq>',
    '  <SFREQUENCIA>',
    `    <CODCOLIGADA>${cfg.rm.escopo.coligada}</CODCOLIGADA>`,
    `    <IDHORARIOTURMA>${alvo.idHorarioTurma}</IDHORARIOTURMA>`,
    `    <IDTURMADISC>${alvo.idTurmaDisc}</IDTURMADISC>`,
    `    <RA>${alvo.ra}</RA>`,
    // SEM fuso, SEM Z: o schema declara DateTimeMode="Unspecified", e horas de
    // deslocamento movem a DATA — que é a entrada de duas resoluções (dia da
    // semana -> IDHORARIOTURMA, e janela -> CODETAPA). Erro de fuso aqui não
    // erra o horário: erra a aula.
    `    <DATA>${alvo.data}T00:00:00</DATA>`,
    `    <PRESENCA>${presenca}</PRESENCA>`,
    '  </SFREQUENCIA>',
    '</EduFrequenciaDiaria>',
  ].join('\n');
}

const p = (s = ''): void => console.log(s);

async function main(): Promise<void> {
  const executar = process.argv.includes('--executar');
  const remover = process.argv.includes('--remover');
  const janela = { de: '2026-03-02', ate: '2026-03-06' };

  const cursos = await idMappingRepository.listByType('COURSE', 'active');
  const alunos = await idMappingRepository.listByType('STUDENT', 'active');
  const rasAtivos = new Set(alunos.map((a) => a.rmCode));

  const alvos = await RmAttendanceTargets.carregar(
    cursos.map((c) => c.rmCode),
    cfg.rm.escopo.filiais,
  );

  // O estado atual do RM na janela — é ele que diz onde NÃO há falta.
  const noRm = await fetchFrequenciaFromRm(janela);
  const ocupadas = indexaFaltasPorChave(noRm.faltas);

  // Procura a primeira aula livre: turma-disciplina com horário e etapa
  // resolvidos, aluno ativo com falta em OUTRA aula (prova que está matriculado
  // ali), e a aula escolhida sem falta.
  let alvo: Alvo | null = null;
  for (const f of noRm.faltas) {
    if (!rasAtivos.has(f.ra)) continue;
    const horarios = alvos.todosHorarios().filter((h) => h.idTurmaDisc === f.idTurmaDisc);
    for (const dataIso of [janela.de, '2026-03-03', '2026-03-04', '2026-03-05', janela.ate]) {
      for (const h of horarios) {
        const rh = alvos.resolveHorario(f.idTurmaDisc, dataIso, h.horaInicial);
        if (!rh || !('horario' in rh)) continue;
        const re = alvos.resolveEtapa(f.idTurmaDisc, dataIso);
        if (!re || !('etapa' in re)) continue;
        const linha: LinhaFrequencia = {
          codColigada: cfg.rm.escopo.coligada,
          idHorarioTurma: rh.horario.idHorarioTurma,
          idTurmaDisc: f.idTurmaDisc,
          ra: f.ra,
          data: dataIso,
          presenca: 'A',
        };
        if (ocupadas.has(chaveNaturalRm(linha))) continue; // já tem falta: não pisar
        alvo = {
          idTurmaDisc: f.idTurmaDisc,
          ra: f.ra,
          data: dataIso,
          idHorarioTurma: rh.horario.idHorarioTurma,
          codEtapa: re.etapa.codEtapa,
          horaInicial: h.horaInicial,
          codTurma: f.codTurma,
          aulasDadas: re.etapa.aulasDadas,
        };
        break;
      }
      if (alvo) break;
    }
    if (alvo) break;
  }

  p('');
  p('══════════════════════════════════════════════════════════════════════');
  p('  Lançamento de UMA falta no RM');
  p('══════════════════════════════════════════════════════════════════════');
  p(`  janela consultada      ${janela.de} → ${janela.ate}`);
  p(`  faltas já no RM        ${noRm.faltas.length}`);
  p(`  turmas com de-para     ${cursos.length}    alunos ativos: ${alunos.length}`);

  if (!alvo) {
    p('');
    p('  Nenhuma aula LIVRE encontrada nesta janela.');
    p('  Todas as combinações (aluno, turma-disciplina, data, horário) resolvíveis');
    p('  já têm falta lançada. Escrever exigiria pisar num registro existente,');
    p('  o que este script recusa a fazer.');
    p('');
    await pgPool.end();
    return;
  }

  const linha: LinhaFrequencia = {
    codColigada: cfg.rm.escopo.coligada,
    idHorarioTurma: alvo.idHorarioTurma,
    idTurmaDisc: alvo.idTurmaDisc,
    ra: alvo.ra,
    data: alvo.data,
    presenca: 'A',
  };
  const chave = chaveNaturalRm(linha);

  p('');
  p('── alvo escolhido (aula SEM falta hoje) ──────────────────────────────');
  p(`  RA                     ${alvo.ra}`);
  p(`  turma-disciplina       ${alvo.idTurmaDisc}${alvo.codTurma ? `  (${alvo.codTurma})` : ''}`);
  p(`  data                   ${alvo.data}   aula das ${alvo.horaInicial}`);
  p(`  IDHORARIOTURMA         ${alvo.idHorarioTurma}`);
  p(`  CODETAPA               ${alvo.codEtapa}   AULASDADAS=${alvo.aulasDadas ?? '(ausente)'}`);
  p(`  chave natural          ${chave}`);
  p('');
  p('── XML que será enviado ──────────────────────────────────────────────');
  for (const l of montaXml(alvo, 'A').split('\n')) p(`  ${l}`);
  p('');
  p(`  AULASDADAS vai ECOADO do RM (${alvo.aulasDadas ?? 'ausente'}), nunca calculado:`);
  p('  é o denominador dos 75% de reprovação por falta. CODSUBTURMA omitido');
  p('  (não existe subturma na coligada).');

  if (!executar) {
    p('');
    p('  NADA FOI ESCRITO. --executar para lançar.');
    p('');
    await pgPool.end();
    return;
  }

  p('');
  p('── escrevendo ────────────────────────────────────────────────────────');
  const r = await wsDataServerClient.saveRecord(
    'EduFrequenciaDiariaWSData',
    montaXml(alvo, 'A'),
    `CODCOLIGADA=${cfg.rm.escopo.coligada};CODFILIAL=${cfg.rm.escopo.filiais};CODTIPOCURSO=1;CODSISTEMA=S`,
  );
  p(`  resultado: ${r.ok ? 'ACEITO' : 'RECUSADO'}`);
  p(`  resposta:  ${r.resposta.slice(0, 300)}`);

  // Confirmação por LEITURA. O `SaveRecord` devolve HTTP 200 mesmo em erro de
  // negócio, então a resposta dele nunca é prova de que gravou.
  p('');
  p('── conferindo por leitura ────────────────────────────────────────────');
  const depois = await fetchFrequenciaFromRm(janela);
  const agora = indexaFaltasPorChave(depois.faltas);
  const gravou = agora.get(chave);
  p(`  faltas na janela: ${noRm.faltas.length} → ${depois.faltas.length}`);
  p(`  a nossa linha:    ${gravou ? 'PRESENTE no RM' : 'NÃO encontrada'}`);
  if (gravou) {
    p(`      presenca=${gravou.presenca}  criadoPelaIntegracao=${gravou.criadoPelaIntegracao}`);
    p(`      criadoEm=${gravou.criadoEm ?? '-'}`);
  }

  if (!remover) {
    p('');
    p('  A falta ficou lançada. Rode com --executar --remover para tentar');
    p("  desfazer com PRESENCA='P' — o que também é um teste, porque essa");
    p('  remoção nunca foi medida.');
    p('');
    await pgPool.end();
    return;
  }

  p('');
  p("── desfazendo com PRESENCA='P' ───────────────────────────────────────");
  const rr = await wsDataServerClient.saveRecord(
    'EduFrequenciaDiariaWSData',
    montaXml(alvo, 'P'),
    `CODCOLIGADA=${cfg.rm.escopo.coligada};CODFILIAL=${cfg.rm.escopo.filiais};CODTIPOCURSO=1;CODSISTEMA=S`,
  );
  p(`  resultado: ${rr.ok ? 'ACEITO' : 'RECUSADO'}`);
  p(`  resposta:  ${rr.resposta.slice(0, 300)}`);

  const final = await fetchFrequenciaFromRm(janela);
  const sumiu = !indexaFaltasPorChave(final.faltas).has(chave);
  p('');
  p(`  faltas na janela: ${depois.faltas.length} → ${final.faltas.length}`);
  p(`  a nossa linha:    ${sumiu ? 'REMOVIDA' : 'AINDA NO RM'}`);
  p('');
  p(
    sumiu
      ? "  MEDIDO: PRESENCA='P' remove o registro. O desfazer existe."
      : `  MEDIDO: PRESENCA='P' NÃO removeu. Remova à mão pela tela do RM:\n` +
        `      RA ${alvo.ra}, turma-disciplina ${alvo.idTurmaDisc}, ${alvo.data}, ` +
        `aula das ${alvo.horaInicial}`,
  );
  p('');
  await pgPool.end();
}

main().catch((err) => {
  logger.error({ err }, 'Falha no lançamento');
  process.exit(1);
});
