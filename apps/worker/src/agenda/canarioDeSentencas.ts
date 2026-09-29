import { alertar, env, logger } from '@rm-toddle/config';
import {
  SENTENCAS_DO_TODDLE,
  conferir,
  type CamadaDeAceite,
  type CodigoDeSentenca,
  type ConferenciaDeSentenca,
} from '@rm-toddle/integrations';

/**
 * CANÁRIO DE SENTENÇAS — o drift que o fail-high do P0-6 vai pegar TARDE.
 *
 * ─── O QUE ESTE ARQUIVO É, E O QUE ELE NÃO É ────────────────────────────────
 *
 * Ele NÃO é um verificador novo. `conferir()`, em
 * `packages/integrations/src/rm-soap/sentencasDoRm.ts`, já compara o corpo do
 * SQL no RM com o `.sql` do repositório caractere a caractere, já confere as
 * flags `SEMSEGCOLUNAS`/`SEMSEGESTENDIDA`, já executa a Sentença e já devolve
 * `colunasAusentes`. O manifesto versionado também já existe.
 *
 * O que faltava eram duas coisas, e só:
 *
 *   1. ninguém chamava `conferir()` por agendamento — só o botão da tela e o
 *      restauro reativo, que é acionado DEPOIS de um job já ter esbarrado;
 *   2. `conferir()` não alertava. Zero chamadas a `alertar()` no arquivo.
 *
 * Este módulo é essas duas coisas.
 *
 * ─── POR QUE O DRIFT ACONTECE SEM NINGUÉM MEXER EM CÓDIGO ───────────────────
 *
 * As Sentenças moram DENTRO do RM, não no repositório. Toda cópia de base por
 * cima do ambiente apaga as seis — aconteceu em 13-15/08, 16/09 e 20/09/2026. O
 * restauro automático recoloca a versão do git, que pode estar ATRÁS da que
 * estava no RM. Ou seja: uma coluna pode sumir do result set sem um único
 * commit, e o sintoma não é erro — é o cruzamento de frequência parar de casar
 * e a proteção contra sobrescrever lançamento de professor se desligar em
 * silêncio (ver `packages/domain/src/chaveNaturalFrequencia.test.ts`).
 *
 * ─── DUAS CAMADAS, DUAS CADÊNCIAS, E ISSO NÃO É ARBITRÁRIO ──────────────────
 *
 * As camadas custam ordens de grandeza diferentes contra um RM que este projeto
 * já viu ficar mudo por horas durante cópia de base. Somar carga evitável a uma
 * dependência frágil é trocar um risco por outro.
 *
 *   RELEITURA   6 `readRecord` do GlbConsSQLData — lê o corpo do SQL e as
 *               flags. Não executa nada. Pega exatamente o evento mais comum:
 *               a Sentença apagada ou rebaixada pela cópia de base.
 *               CADÊNCIA: de hora em hora. 144 chamadas/dia.
 *
 *   EXECUÇÃO    roda as seis. `TODDLE.NOTAS` NÃO aceita janela e devolve o
 *               período inteiro, ~7 mil linhas por SOAP (só `TODDLE.FREQ` e
 *               `TODDLE.PLANOAULA` recortam 7 dias). Pega o drift que NÃO muda
 *               o corpo — coluna que some por permissão, por exemplo.
 *               CADÊNCIA: 1x por dia.
 *
 * Por que a releitura não roda a cada ciclo do vigia (15 min): seriam 576
 * chamadas/dia, 4x mais, para adiantar a detecção em no máximo 45 minutos de um
 * evento que não é sub-horário. E o fluxo mais frequente — notas, a cada 15/45
 * min — já terá a falha alta no ponto de uso quando o P0-6 entrar. A camada
 * rasa não precisa correr atrás da profunda.
 */

/** O que o canário conclui sobre uma Sentença. */
export type EstadoDaSentenca = 'ok' | 'ausente' | 'divergente';

export interface AchadoDeSentenca {
  codigo: CodigoDeSentenca;
  estado: EstadoDaSentenca;
  /** Qual camada reprovou. `null` quando está ok. */
  camada: CamadaDeAceite | null;
  detalhe: string;
  /** Só quando a execução rodou e faltou coluna. Vai no CONTEXTO, nunca no assunto. */
  colunasAusentes: string[];
}

/**
 * Lê uma conferência e diz se há achado.
 *
 * ─── A ARMADILHA QUE ISTO EVITA ─────────────────────────────────────────────
 *
 * `ConferenciaDeSentenca.confere` é `true` só quando as TRÊS camadas passam. Na
 * passada barata, `executar: false`, a camada de execução devolve
 * `ok: false, detalhe: 'não executada'` — de propósito, porque "não verifiquei"
 * não pode virar "está bom".
 *
 * O efeito, para quem lê o campo errado: `confere` é SEMPRE `false` na passada
 * barata. Um canário que alertasse por `!confere` mandaria seis notificações por
 * hora, para sempre, sobre Sentenças perfeitas — e o canal seria silenciado no
 * primeiro dia, junto com todo o resto que ele carrega.
 *
 * Por isso a leitura é por CAMADA, e `verificacaoCompleta` decide quais camadas
 * têm voz nesta passada.
 */
export function achadoDe(c: ConferenciaDeSentenca): AchadoDeSentenca | null {
  if (!c.existeNoRm) {
    return {
      codigo: c.codigo,
      estado: 'ausente',
      camada: 'releitura',
      detalhe: c.releitura.detalhe,
      colunasAusentes: [],
    };
  }

  if (!c.releitura.ok) {
    return {
      codigo: c.codigo,
      estado: 'divergente',
      camada: 'releitura',
      detalhe: c.releitura.detalhe,
      colunasAusentes: [],
    };
  }

  /*
   * Daqui para baixo só vale se a verificação foi COMPLETA. Numa passada
   * barata, execução e volume dizem "não contado" / "não executada", e tratar
   * isso como reprovação é o defeito descrito acima.
   */
  if (!c.verificacaoCompleta) return null;

  if (!c.execucao.ok) {
    return {
      codigo: c.codigo,
      estado: 'divergente',
      camada: 'execucao',
      detalhe: c.execucao.detalhe,
      colunasAusentes: c.execucao.colunasAusentes,
    };
  }

  if (!c.volume.ok) {
    return {
      codigo: c.codigo,
      estado: 'divergente',
      camada: 'volume',
      detalhe: c.volume.detalhe,
      colunasAusentes: [],
    };
  }

  return null;
}

/**
 * O assunto do alerta. ESTÁVEL, por contrato do P0-2.
 *
 * O assunto é a chave da supressão. Nada de mutável entra aqui: nem o detalhe
 * (que carrega contagem e mensagem do RM), nem `colunasAusentes` (que muda
 * conforme a Sentença é editada). Esses vão no `contexto`, que é renderizado no
 * corpo da notificação e não participa da chave.
 *
 * A camada ENTRA no assunto de propósito: "sumiu do RM" e "executa mas devolve
 * menos coluna" são incidentes diferentes, com consertos diferentes, e merecem
 * janelas de supressão independentes.
 */
export function assuntoDeSentenca(codigo: string, camada: CamadaDeAceite): string {
  const porCamada: Record<CamadaDeAceite, string> = {
    releitura: 'corpo divergente ou ausente no RM',
    execucao: 'executa, mas o result set mudou',
    volume: 'volume fora do esperado',
  };
  return `Sentença ${codigo}: ${porCamada[camada]}`;
}

/** O par. Fechar o incidente é parte de relatá-lo — mesma regra do P0-3. */
export function assuntoDeSentencaVoltou(codigo: string): string {
  return `Sentença ${codigo}: voltou a conferir`;
}

/**
 * O que MUDOU desde a passada anterior.
 *
 * Pura, e recebe a memória de fora, como `transicoes` em `apps/api`. Sem isso
 * não dá para testar "divergiu, o restauro reativo consertou, voltou" sem um RM
 * de verdade.
 *
 * ─── UMA SENTENÇA QUE NÃO FOI VERIFICADA NÃO MUDA DE ESTADO ─────────────────
 *
 * `avaliadas` diz quais Sentenças esta passada realmente olhou. Sem esse
 * recorte, uma passada que falhasse no meio (rede caindo na terceira das seis)
 * apagaria a memória das três restantes e, na passada seguinte, emitiria
 * "voltou a conferir" sobre Sentenças que ninguém verificou — um fechamento de
 * incidente falso, que é pior que nenhum.
 */
export interface TransicaoDeSentenca {
  codigo: string;
  para: 'achado' | 'voltou';
  achado: AchadoDeSentenca | null;
}

export function transicoesDeSentenca(
  anterior: Map<string, EstadoDaSentenca>,
  achados: AchadoDeSentenca[],
  avaliadas: readonly string[],
): TransicaoDeSentenca[] {
  const porCodigo = new Map(achados.map((a) => [a.codigo as string, a]));
  const mudou: TransicaoDeSentenca[] = [];

  for (const codigo of avaliadas) {
    const achado = porCodigo.get(codigo) ?? null;
    const agora: EstadoDaSentenca = achado ? achado.estado : 'ok';
    const antes = anterior.get(codigo);

    if (antes === agora) continue;
    // Nunca vista e já ok: não há incidente a relatar.
    if (antes === undefined && agora === 'ok') continue;

    mudou.push({ codigo, para: agora === 'ok' ? 'voltou' : 'achado', achado });
  }
  return mudou;
}

// ─── A PARTE QUE FALA COM O MUNDO ───────────────────────────────────────────

/** Memória entre passadas. Só o que foi avaliado é atualizado. */
const estadoAnterior = new Map<string, EstadoDaSentenca>();

/**
 * Janela de repetição dos achados.
 *
 * Doze horas, e não os 10 min default: Sentença divergente é CONDIÇÃO — ela
 * continua divergente até alguém restaurar. Mais longa que as 6h do vigia
 * porque a cadência aqui também é mais lenta, e duas notificações por dia sobre
 * o mesmo drift já são o suficiente para ninguém esquecer dele.
 */
const REPETIR_ACHADO_APOS_MS = 12 * 60 * 60 * 1_000;

/** Só de uma em uma: seis execuções em paralelo contra o RM é o oposto do cuidado. */
async function emSerie<T, R>(itens: readonly T[], f: (item: T) => Promise<R>): Promise<R[]> {
  const saida: R[] = [];
  for (const item of itens) saida.push(await f(item));
  return saida;
}

export interface PassadaDoCanario {
  executou: boolean;
  avaliadas: string[];
  achados: AchadoDeSentenca[];
  /** Sentenças que nem deu para verificar (erro na conferência). */
  naoVerificadas: string[];
}

/**
 * Uma passada. Nunca lança — canário que derruba o worker é pior que canário
 * nenhum, pela mesma disciplina de `alertar` e `pingHeartbeat`.
 *
 * Cada Sentença é conferida em `try` próprio: uma falha de rede na terceira não
 * pode custar a verificação das outras três, nem apagar a memória delas.
 */
export async function conferirSentencasUmaVez(
  opcoes: { executar: boolean } = { executar: false },
): Promise<PassadaDoCanario> {
  const achados: AchadoDeSentenca[] = [];
  const avaliadas: string[] = [];
  const naoVerificadas: string[] = [];

  await emSerie(SENTENCAS_DO_TODDLE, async (codigo) => {
    try {
      const c = await conferir(codigo, undefined, { executar: opcoes.executar });
      avaliadas.push(codigo);
      const achado = achadoDe(c);
      if (achado) achados.push(achado);
    } catch (err) {
      naoVerificadas.push(codigo);
      logger.warn(
        { codigo, err: (err as Error).message },
        'Canário: não consegui conferir esta Sentença nesta passada',
      );
    }
  });

  return { executou: opcoes.executar, avaliadas, achados, naoVerificadas };
}

/** Confere e alerta o que mudou. Nunca lança. */
export async function canariarEAlertar(opcoes: { executar: boolean }): Promise<void> {
  try {
    const passada = await conferirSentencasUmaVez(opcoes);

    for (const t of transicoesDeSentenca(estadoAnterior, passada.achados, passada.avaliadas)) {
      if (t.para === 'achado' && t.achado) {
        logger.error(
          { codigo: t.codigo, camada: t.achado.camada, detalhe: t.achado.detalhe },
          'Canário: Sentença divergiu do repositório',
        );
        await alertar({
          assunto: assuntoDeSentenca(t.codigo, t.achado.camada ?? 'releitura'),
          contexto: {
            codigo: t.codigo,
            estado: t.achado.estado,
            detalhe: t.achado.detalhe,
            colunasAusentes:
              t.achado.colunasAusentes.length > 0 ? t.achado.colunasAusentes.join(', ') : undefined,
            porqueImporta:
              'coluna que some do result set vira segmento vazio na chave natural, e o ' +
              'cruzamento de frequência para de casar sem erro nenhum',
            comoVer: 'npm run canario',
          },
          repetirApos: REPETIR_ACHADO_APOS_MS,
        });
      } else {
        logger.info({ codigo: t.codigo }, 'Canário: Sentença voltou a conferir');
        await alertar({
          assunto: assuntoDeSentencaVoltou(t.codigo),
          contexto: {
            codigo: t.codigo,
            significado: 'o incidente anterior desta Sentença está encerrado',
          },
          repetirApos: REPETIR_ACHADO_APOS_MS,
        });
      }
    }

    // SÓ as avaliadas. Ver a nota em `transicoesDeSentenca`.
    for (const codigo of passada.avaliadas) {
      const achado = passada.achados.find((a) => a.codigo === codigo);
      estadoAnterior.set(codigo, achado ? achado.estado : 'ok');
    }

    if (passada.achados.length === 0 && passada.naoVerificadas.length === 0) {
      logger.debug(
        { camada: opcoes.executar ? 'completa' : 'releitura', avaliadas: passada.avaliadas.length },
        'Canário: as Sentenças conferem',
      );
    }
  } catch (err) {
    logger.error(
      { err },
      'FALHA no canário de Sentenças — nenhuma divergência será detectada nesta volta, e ' +
        'canário quebrado é indistinguível de Sentença saudável',
    );
  }
}

/**
 * Liga as duas cadências. Devolve a função de encerramento.
 *
 * A primeira passada NÃO é imediata: no boot o worker acabou de subir e o
 * `conferir` fala com o RM por SOAP — somar isso à largada, junto com a
 * reconciliação da agenda e o primeiro ciclo do vigia, é pedir para o boot
 * competir consigo mesmo.
 */
export function ligarCanario(): () => void {
  const releitura = setInterval(
    () => void canariarEAlertar({ executar: false }),
    env.CANARIO_RELEITURA_MS,
  );
  const execucao = setInterval(
    () => void canariarEAlertar({ executar: true }),
    env.CANARIO_EXECUCAO_MS,
  );

  logger.info(
    {
      releituraMs: env.CANARIO_RELEITURA_MS,
      execucaoMs: env.CANARIO_EXECUCAO_MS,
      sentencas: SENTENCAS_DO_TODDLE.length,
    },
    'Canário de Sentenças ativo (corpo de hora em hora, execução 1x/dia)',
  );

  return () => {
    clearInterval(releitura);
    clearInterval(execucao);
  };
}
