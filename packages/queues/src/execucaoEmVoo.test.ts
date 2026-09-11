import { describe, expect, it } from 'vitest';
import { eMarcadorDeProximoDisparo, execucoesEmVoo, type JobEmVoo } from './execucaoEmVoo';

/**
 * O caso que motivou estes testes está no primeiro `it`: o marcador do próximo
 * disparo do cron. Ele fez o botão "Sincronizar agora" recusar SEMPRE em fluxo
 * ligado, e passou na minha verificação porque testei só no fluxo desligado —
 * o único sem scheduler, e portanto o único sem marcador.
 */
describe('eMarcadorDeProximoDisparo', () => {
  it('reconhece a reserva do próximo cron: delayed COM repeatJobKey', () => {
    // Formato real, lido da fila `rm-to-toddle.students` em 11/09/2026.
    expect(eMarcadorDeProximoDisparo({ estado: 'delayed', repeatJobKey: 'students.sync' })).toBe(true);
  });

  it('NÃO trata job em backoff como marcador: delayed SEM repeatJobKey', () => {
    expect(eMarcadorDeProximoDisparo({ estado: 'delayed' })).toBe(false);
    expect(eMarcadorDeProximoDisparo({ estado: 'delayed', repeatJobKey: null })).toBe(false);
  });

  // A distinção não é "veio do scheduler". Assim que o cron dispara, o job é
  // trabalho de verdade e tem de bloquear o disparo manual — senão os dois
  // rodam em sequência e o segundo reescreve o que o primeiro escreveu.
  it.each(['active', 'waiting', 'paused', 'prioritized'] as const)(
    'NÃO trata job %s do scheduler como marcador',
    (estado) => {
      expect(eMarcadorDeProximoDisparo({ estado, repeatJobKey: 'students.sync' })).toBe(false);
    },
  );
});

describe('execucoesEmVoo', () => {
  it('fluxo LIGADO e parado: só o marcador na fila, nada em voo', () => {
    expect(execucoesEmVoo([{ estado: 'delayed', repeatJobKey: 'students.sync' }])).toHaveLength(0);
  });

  it('fluxo ligado com uma execução manual esperando: conta a manual', () => {
    const emVoo = execucoesEmVoo([
      { estado: 'delayed', repeatJobKey: 'students.sync' },
      { estado: 'waiting' },
    ]);
    expect(emVoo).toHaveLength(1);
    expect(emVoo[0].estado).toBe('waiting');
  });

  it('job do cron rodando: conta, mesmo tendo repeatJobKey', () => {
    expect(
      execucoesEmVoo([
        { estado: 'active', repeatJobKey: 'staff.sync' },
        { estado: 'delayed', repeatJobKey: 'staff.sync' },
      ]),
    ).toHaveLength(1);
  });

  // Foi o primeiro furo: fila pausada põe o job em `paused`, e a versão que
  // somava só waiting+active+delayed deixava passar.
  it('fila pausada: o job preso continua contando', () => {
    expect(execucoesEmVoo([{ estado: 'paused' }, { estado: 'paused' }])).toHaveLength(2);
  });

  it('fila vazia: nada em voo', () => {
    expect(execucoesEmVoo([])).toHaveLength(0);
  });
});
