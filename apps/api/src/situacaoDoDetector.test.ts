import { describe, expect, it } from 'vitest';
import { janelaLegivel, situacaoDoDetector, type DetectorParaSituacao } from './situacaoDoDetector';

// 13:00 em São Paulo
const AGORA = new Date('2026-10-09T16:00:00Z');

const base: DetectorParaSituacao = {
  ativo: true,
  intervaloSegundos: 60,
  horaInicio: 6,
  horaFim: 22,
  timezone: 'America/Sao_Paulo',
  atualizadoEm: '2026-10-09T10:00:00Z',
  ultimaSondagemEm: '2026-10-09T15:59:30Z',
  falhasSeguidas: 0,
  pausadoAte: null,
  ultimoErro: null,
  ultimoErroEm: null,
};

const sit = (d: Partial<DetectorParaSituacao> | null) =>
  situacaoDoDetector(d === null ? null : { ...base, ...d }, AGORA).situacao;

describe('situacaoDoDetector', () => {
  it('sondou há 30 s com intervalo de 1 min: ativo', () => {
    expect(sit({})).toBe('ativo');
  });

  it('sem linha: o worker ainda não passou', () => {
    expect(sit(null)).toBe('sem-linha');
  });

  it('desligado vence qualquer outra coisa', () => {
    expect(sit({ ativo: false, falhasSeguidas: 3 })).toBe('desligado');
  });

  it('pausado enquanto a pausa não venceu, e só enquanto', () => {
    expect(sit({ pausadoAte: '2026-10-09T16:20:00Z' })).toBe('pausado');
    expect(sit({ pausadoAte: '2026-10-09T15:00:00Z' })).toBe('ativo');
  });

  it('fora do horário não é parado', () => {
    expect(sit({ horaInicio: 6, horaFim: 12, ultimaSondagemEm: '2026-10-09T14:00:00Z' })).toBe('fora-do-horario');
  });

  it('com falhas seguidas e voltas recentes: com-erro', () => {
    expect(sit({ falhasSeguidas: 2, ultimoErroEm: '2026-10-09T15:59:00Z' })).toBe('com-erro');
  });

  it('falhas antigas e nenhuma volta recente: PARADO vence com-erro — o worker morreu', () => {
    expect(
      sit({ falhasSeguidas: 2, ultimoErroEm: '2026-10-09T14:00:00Z', ultimaSondagemEm: '2026-10-09T13:00:00Z' }),
    ).toBe('parado');
  });

  it('a trava do RM pausa todo detector ligado', () => {
    const r = situacaoDoDetector({ ...base }, AGORA, { ate: '2026-10-09T16:30:00Z', motivo: 'x', recusas: 1 });
    expect(r.situacao).toBe('pausado');
  });

  it('LIGADO, no horário e sem sondar há 20 min: parado — o verde que mentiria', () => {
    expect(sit({ ultimaSondagemEm: '2026-10-09T15:40:00Z' })).toBe('parado');
  });

  it('acabou de ser ligado: a última sondagem antiga não acusa parado', () => {
    expect(sit({ ultimaSondagemEm: '2026-10-08T15:00:00Z', atualizadoEm: '2026-10-09T15:59:00Z' })).toBe('ativo');
  });

  it('nunca sondou e foi ligado há muito: parado', () => {
    expect(sit({ ultimaSondagemEm: null, atualizadoEm: '2026-10-09T12:00:00Z' })).toBe('parado');
  });

  it('logo depois de a janela abrir, a volta de ontem à noite não acusa parado', () => {
    // 06:02 em SP; a última volta foi às 21:59 de ontem.
    const r = situacaoDoDetector(
      { ...base, ultimaSondagemEm: '2026-10-09T00:59:00Z', atualizadoEm: '2026-10-08T10:00:00Z' },
      new Date('2026-10-09T09:02:00Z'),
    );
    expect(r.situacao).toBe('ativo');
  });

  it('mas às 06:40 sem nenhuma volta desde ontem, é parado — não espera até as 7h', () => {
    const r = situacaoDoDetector(
      { ...base, ultimaSondagemEm: '2026-10-09T00:59:00Z', atualizadoEm: '2026-10-08T10:00:00Z' },
      new Date('2026-10-09T09:40:00Z'),
    );
    expect(r.situacao).toBe('parado');
  });
});

describe('janelaLegivel', () => {
  it('formata e trata o dia inteiro', () => {
    expect(janelaLegivel(6, 22)).toBe('06h–22h');
    expect(janelaLegivel(0, 0)).toBe('o dia inteiro');
  });
});
