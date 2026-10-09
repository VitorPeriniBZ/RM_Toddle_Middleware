import { dentroDoHorario, minutoDoDiaNoFuso } from '@rm-toddle/domain';

/**
 * O estado de um detector, em UMA palavra — e a frase que explica a palavra.
 *
 * Mesma regra do selo da agenda: o pior vence, e a precedência é explícita.
 * Ela vive no SERVIDOR, não na tela, porque depende do relógio e do fuso do
 * detector; duas implementações da mesma comparação divergem, e a que divergiria
 * em silêncio seria a da tela.
 *
 * ─── "PARADO" É O QUE ESTA FUNÇÃO EXISTE PARA DIZER ─────────────────────────
 *
 * "Ligado" na intenção não prova nada. Se o worker caiu, ou o laço do detector
 * morreu, a linha continua dizendo `ativo = true` e a tela mostraria verde para
 * sempre. A pergunta certa é: ligado, no horário, e SEM sondar há mais tempo do
 * que o intervalo explicaria? Isso é detector parado — o equivalente do
 * "nenhum sucesso dentro da janela" do vigia.
 */
export type Situacao =
  | 'sem-linha'
  | 'desligado'
  | 'pausado'
  | 'fora-do-horario'
  | 'com-erro'
  | 'parado'
  | 'ativo';

export interface DetectorParaSituacao {
  ativo: boolean;
  intervaloSegundos: number;
  horaInicio: number;
  horaFim: number;
  timezone: string;
  atualizadoEm: string;
  ultimaSondagemEm: string | null;
  falhasSeguidas: number;
  pausadoAte: string | null;
  ultimoErro: string | null;
  ultimoErroEm: string | null;
}

/** A trava compartilhada de credencial do RM, quando vale. Ver travaDoRm.ts. */
export interface TravaParaSituacao {
  ate: string;
  motivo: string;
  recusas: number;
}

/**
 * Folga além do intervalo antes de chamar de "parado": o laço relê a config a
 * cada 30 s quando acabou de ser ligado, e uma volta lenta (RM em 5 s, Toddle
 * esperando vaga no limitador) não pode virar alarme.
 */
const FOLGA_PARA_PARADO_MS = 3 * 60_000;

export function situacaoDoDetector(
  d: DetectorParaSituacao | null,
  agora: Date,
  trava: TravaParaSituacao | null = null,
): { situacao: Situacao; explicacao: string } {
  if (!d) {
    return {
      situacao: 'sem-linha',
      explicacao:
        'O worker cria a linha deste detector na primeira volta depois de subir. Se isto persistir, ' +
        'o worker desta versão não está de pé.',
    };
  }
  if (!d.ativo) {
    return { situacao: 'desligado', explicacao: 'Desligado: só a agenda comum leva as mudanças.' };
  }
  if (trava) {
    return {
      situacao: 'pausado',
      explicacao:
        `O RM recusou a credencial da integração (${trava.recusas}ª recusa seguida), e todos os ` +
        `detectores esperam até ${horaLocal(trava.ate)} para não bloquear o usuário no RM. Se a senha ` +
        'já foi corrigida, use "Retomar".',
    };
  }
  if (d.pausadoAte && Date.parse(d.pausadoAte) > agora.getTime()) {
    return {
      situacao: 'pausado',
      explicacao: d.ultimoErro ?? 'Pausado depois de uma recusa de credencial do RM.',
    };
  }
  if (!dentroDoHorario(agora, d.timezone, d.horaInicio, d.horaFim)) {
    return {
      situacao: 'fora-do-horario',
      explicacao: `Fora do horário (${janelaLegivel(d.horaInicio, d.horaFim)}). Volta sozinho quando a janela abrir.`,
    };
  }

  // "Parado" vem ANTES de "com erro": um laço que falha ainda está vivo (grava
  // o erro a cada volta), e um worker morto com falhas antigas na linha nunca
  // apareceria como parado. A prova de vida é qualquer volta — com ou sem erro —
  // ou alguém ter mexido na linha (ligar agora não acusa parado).
  const referencia = Math.max(
    d.ultimaSondagemEm ? Date.parse(d.ultimaSondagemEm) : 0,
    d.ultimoErroEm ? Date.parse(d.ultimoErroEm) : 0,
    Date.parse(d.atualizadoEm),
  );
  const limite = d.intervaloSegundos * 1_000 + FOLGA_PARA_PARADO_MS;
  // Logo depois de a janela abrir, a última volta é a de ontem à noite — isso
  // não é parada. Isenta só o tempo de uma volta, não a primeira hora inteira:
  // um worker que morreu de madrugada tem de aparecer parado minutos depois da
  // abertura, não às 7h.
  const abriuHaMs =
    d.horaInicio === d.horaFim
      ? Infinity
      : (((minutoDoDiaNoFuso(agora, d.timezone) - d.horaInicio * 60) % 1440) + 1440) % 1440 * 60_000;
  if (agora.getTime() - referencia > limite && abriuHaMs > limite) {
    return {
      situacao: 'parado',
      explicacao:
        'Ligado e no horário, mas sem dar volta há mais tempo do que o intervalo explica. O worker ' +
        'pode estar fora do ar — e então a varredura agendada também não está rodando.',
    };
  }
  if (d.falhasSeguidas > 0) {
    return {
      situacao: 'com-erro',
      explicacao: `${d.falhasSeguidas} volta(s) seguida(s) com erro — esperando cada vez mais entre tentativas.`,
    };
  }
  return { situacao: 'ativo', explicacao: 'Sondando.' };
}

/** "15:42" no fuso da escola — a pessoa lê a hora, não um ISO. */
function horaLocal(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', {
    timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit',
  });
}

export function janelaLegivel(inicio: number, fim: number): string {
  if (inicio === fim) return 'o dia inteiro';
  const h = (n: number): string => `${String(n).padStart(2, '0')}h`;
  return `${h(inicio)}–${h(fim)}`;
}
