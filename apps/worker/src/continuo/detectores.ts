import { alertar, env, logger } from '@rm-toddle/config';
import {
  lerAgenda,
  lerDetector,
  registrarVolta,
  semearDetector,
  type ContadoresDoDia,
  type DesfechosDoDisparo,
  type DetectorComEstado,
} from '@rm-toddle/db';
import { recusouCredencialDoRm } from '@rm-toddle/integrations';
import {
  DETECTORES_EM_ORDEM,
  DETECTOR,
  acharFluxo,
  credencialDoRmAceita,
  dispararPorMudanca,
  registrarRecusaDeCredencialDoRm,
  travaDoRm,
  type DefinicaoDeDetector,
} from '@rm-toddle/queues';
import { dentroDoHorario, diaNoFuso, esperaAposFalha } from '@rm-toddle/domain';
import { SONDAS, type ResultadoDaSonda } from './sondas';

/**
 * O LAÇO DOS DETECTORES — "tempo quase real", do lado do worker.
 *
 * Cada detector do catálogo (packages/queues/src/detectores.ts) roda num laço
 * próprio: lê a própria linha em `fluxo_continuo`, sonda se estiver ligado e no
 * horário, e dispara os fluxos quando a sonda vê novidade. Um laço por detector,
 * e não um só, para que o RM mudo durante uma cópia de base não atrase a
 * pergunta ao Toddle, e vice-versa.
 *
 * ─── O QUE ELE DISPARA É O FLUXO DE SEMPRE ──────────────────────────────────
 *
 * O detector não escreve no RM nem no Toddle. Ele enfileira o job do fluxo
 * (`dispararPorMudanca`), que roda com os mesmos guardas da varredura agendada.
 * E só dispara fluxo LIGADO na agenda: desligar "Notas" na tela desliga também
 * o caminho rápido, sem segundo interruptor escondido.
 *
 * ─── NUNCA LANÇA, NUNCA INSISTE NO QUE BLOQUEIA ─────────────────────────────
 *
 * Erro numa volta vira registro e espera crescente (`esperaAposFalha`), não
 * exceção: o laço não pode derrubar o worker que hospeda os fluxos. A exceção à
 * espera crescente é a recusa de credencial do RM: ela grava a TRAVA
 * compartilhada (`travaDoRm.ts`) e TODOS os detectores param — inclusive os do
 * Toddle, porque todo fluxo que eles disparam lê o RM. O RM bloqueia o usuário
 * depois de ~6 recusas; um detector insistindo seria a causa.
 */

/** Detector desligado ou ainda sem linha: de quanto em quanto olhar de novo. */
const RELER_CONFIG_MS = 30_000;
/** Fora do horário: basta conferir a cada minuto se a janela abriu. */
const FORA_DO_HORARIO_MS = 60_000;
/** Falhas seguidas a partir das quais o canal de aviso é acionado. */
const FALHAS_PARA_AVISAR = 5;
/** Achado persistente: repete o aviso a cada 6h, como o vigia. */
const REPETIR_AVISO_MS = 6 * 3_600_000;

interface Sinal {
  parado: boolean;
  acordar: Array<() => void>;
}

function dormir(ms: number, sinal: Sinal): Promise<void> {
  return new Promise((resolve) => {
    if (sinal.parado) return resolve();
    const t = setTimeout(fim, ms);
    function fim(): void {
      clearTimeout(t);
      sinal.acordar = sinal.acordar.filter((f) => f !== fim);
      resolve();
    }
    sinal.acordar.push(fim);
  });
}

function contadoresDoDia(atual: ContadoresDoDia, dia: string): Required<ContadoresDoDia> {
  if (atual.dia !== dia) return { dia, sondagens: 0, mudancas: 0, disparos: 0 };
  return {
    dia,
    sondagens: atual.sondagens ?? 0,
    mudancas: atual.mudancas ?? 0,
    disparos: atual.disparos ?? 0,
  };
}

/**
 * Pede os fluxos que a novidade exige. Fluxo desligado ou bloqueado NÃO roda —
 * e o desfecho diz por quê, para a tela não mostrar "mudou" sem consequência
 * aparente.
 */
async function dispararFluxos(
  def: DefinicaoDeDetector,
  r: ResultadoDaSonda,
): Promise<{ desfechos: DesfechosDoDisparo; inicios: Record<string, string>; enfileirados: number }> {
  const desfechos: DesfechosDoDisparo = {};
  const inicios: Record<string, string> = {};
  let enfileirados = 0;
  for (const key of r.fluxos) {
    const fluxo = acharFluxo(key);
    if (!fluxo) {
      desfechos[key] = 'fluxo-desconhecido';
      continue;
    }
    if (!fluxo.podeAtivar) {
      desfechos[key] = 'fluxo-bloqueado';
      continue;
    }
    const agenda = await lerAgenda(key);
    if (!agenda?.ativo) {
      desfechos[key] = 'fluxo-desligado';
      continue;
    }
    const d = await dispararPorMudanca(fluxo, { detector: def.chave, resumo: r.resumo });
    desfechos[key] = d.desfecho;
    if (d.inicioEm) inicios[key] = d.inicioEm;
    if (d.desfecho === 'enfileirado') enfileirados += 1;
  }
  return { desfechos, inicios, enfileirados };
}

/**
 * Uma volta de um detector. Devolve quanto esperar até a próxima.
 *
 * Exportada para teste e para o CLI — o laço é só `while` em volta disto.
 */
export async function umaVolta(def: DefinicaoDeDetector, agora = new Date()): Promise<number> {
  let det: DetectorComEstado | null = await lerDetector(def.chave);
  if (!det) {
    await semearDetector(def.chave, def.padrao);
    det = await lerDetector(def.chave);
    if (!det) return RELER_CONFIG_MS;
  }

  if (!det.ativo) return RELER_CONFIG_MS;
  if (!dentroDoHorario(agora, det.timezone, det.horaInicio, det.horaFim)) return FORA_DO_HORARIO_MS;

  const intervaloMs = det.intervaloSegundos * 1_000;
  if (det.pausadoAte && Date.parse(det.pausadoAte) > agora.getTime()) {
    return Math.min(Date.parse(det.pausadoAte) - agora.getTime(), FORA_DO_HORARIO_MS);
  }
  // A trava é de TODOS: nenhum detector sonda nem dispara enquanto o RM estiver
  // recusando a credencial. Sem sondar, a memória não anda, e o que mudar no
  // Toddle nesse meio-tempo é visto na primeira volta depois que a trava cair.
  const trava = await travaDoRm();
  if (trava) return Math.min(trava.restanteMs, FORA_DO_HORARIO_MS);

  const cont = contadoresDoDia(det.contadores, diaNoFuso(agora, det.timezone));
  const versao = det.atualizadoEm;

  try {
    const r = await SONDAS[def.chave](det.estado, agora);
    cont.sondagens += 1;
    // A sonda de cadastros autenticou no RM: a senha está boa agora.
    if (def.chave === DETECTOR.CADASTRO) await credencialDoRmAceita();

    if (r.novidades === 0) {
      await registrarVolta(def.chave, versao, {
        estado: r.estado,
        sondou: true,
        mudou: false,
        erro: null,
        falhasSeguidas: 0,
        pausadoAte: null,
        contadores: cont,
      });
      if (r.primeiraVez) logger.info({ detector: def.chave, resumo: r.resumo }, 'Detector: linha de base gravada');
      return intervaloMs;
    }

    const { desfechos, inicios, enfileirados } = await dispararFluxos(def, r);
    cont.mudancas += 1;
    cont.disparos += enfileirados;
    await registrarVolta(def.chave, versao, {
      estado: r.estado,
      sondou: true,
      mudou: true,
      disparo: { desfechos, inicios, resumo: r.resumo },
      erro: null,
      falhasSeguidas: 0,
      pausadoAte: null,
      contadores: cont,
    });
    logger.info(
      { detector: def.chave, resumo: r.resumo, desfechos, chamadas: r.chamadas },
      'Detector viu mudança',
    );
    return intervaloMs;
  } catch (err) {
    const mensagem = (err as Error).message ?? String(err);
    const falhas = det.falhasSeguidas + 1;
    const credencial = recusouCredencialDoRm(err);
    const trava = credencial
      ? await registrarRecusaDeCredencialDoRm(env.CONTINUO_PAUSA_CREDENCIAL_MIN * 60_000, mensagem).catch(() => null)
      : null;
    // Sem Redis para gravar a trava, a pausa fica ao menos neste detector.
    const pausadoAte = credencial
      ? new Date(trava ? Date.parse(trava.ate) : agora.getTime() + env.CONTINUO_PAUSA_CREDENCIAL_MIN * 60_000)
      : null;

    await registrarVolta(def.chave, versao, {
      // Sem `estado`: a memória da volta anterior continua valendo. Avançar a
      // marca numa volta que falhou perderia o que ela não conseguiu ler.
      sondou: false,
      mudou: false,
      erro: credencial
        ? `${mensagem} — TODOS os detectores pausados até ${pausadoAte?.toISOString()} para não bloquear o ` +
          'usuário no RM. A pausa cresce a cada recusa seguida; corrigida a senha, use "Retomar" na tela.'
        : mensagem,
      falhasSeguidas: falhas,
      pausadoAte,
      contadores: cont,
    });

    logger.error({ detector: def.chave, falhas, err: mensagem, pausado: Boolean(pausadoAte) }, 'Detector: volta falhou');

    // `>=`, não `===`: a condição persiste, e é o `repetirApos` do `alertar`
    // que espaça a repetição. Com `===` o aviso saía uma vez e nunca mais.
    if (credencial || falhas >= FALHAS_PARA_AVISAR) {
      await alertar({
        assunto: credencial
          ? `Detector "${def.rotulo}" pausado: o RM recusou a credencial`
          : `Detector "${def.rotulo}" falhando seguidamente`,
        contexto: {
          detector: def.chave,
          falhasSeguidas: falhas,
          erro: mensagem.slice(0, 300),
          efeito:
            'o tempo quase real deste detector está parado; a varredura agendada continua ' +
            'sendo a garantia',
        },
        repetirApos: REPETIR_AVISO_MS,
      }).catch(() => undefined);
    }

    return pausadoAte ? FORA_DO_HORARIO_MS : esperaAposFalha(falhas, intervaloMs);
  }
}

/**
 * Liga os detectores. Devolve o encerramento, que espera a volta em curso
 * terminar (até 20 s) — uma volta interrompida no meio não grava a memória, e a
 * seguinte só repetiria a pergunta.
 */
export function ligarDetectores(): () => Promise<void> {
  const sinal: Sinal = { parado: false, acordar: [] };

  const lacos = DETECTORES_EM_ORDEM.map(async (def, i) => {
    // Escalonados na subida: três detectores perguntando no mesmo segundo do
    // boot é uma rajada sem motivo, e o deploy já acabou de rodar o `init`.
    await dormir(15_000 + i * 7_000, sinal);
    while (!sinal.parado) {
      let espera = RELER_CONFIG_MS;
      try {
        espera = await umaVolta(def);
      } catch (err) {
        // `umaVolta` não lança por erro de sondagem; isto é o banco fora do ar
        // ou defeito nosso. Loga alto e tenta de novo — o laço não pode morrer
        // em silêncio, que é o modo de falha que o vigia existe para pegar.
        logger.error({ detector: def.chave, err }, 'Detector: falha fora da sondagem — tentando de novo');
      }
      await dormir(espera, sinal);
    }
  });

  logger.info(
    { detectores: DETECTORES_EM_ORDEM.map((d) => d.chave), folgaMin: env.CONTINUO_FOLGA_MIN, fusoDoRm: env.CONTINUO_RM_FUSO },
    'Detectores de mudança no ar (cada um obedece a própria linha em fluxo_continuo; nascem desligados)',
  );

  return async () => {
    sinal.parado = true;
    for (const f of [...sinal.acordar]) f();
    await Promise.race([Promise.all(lacos), new Promise((r) => setTimeout(r, 20_000))]);
  };
}
