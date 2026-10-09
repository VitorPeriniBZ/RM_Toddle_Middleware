import { describe, expect, it } from 'vitest';
import {
  dentroDoHorario,
  diaNoFuso,
  esperaAposFalha,
  ESPERA_MAXIMA_APOS_FALHA_MS,
  impressaoDe,
  instanteNoFuso,
  maiorCarimbo,
  recuarCarimboDoToddle,
  recuarRelogioDeParede,
  separarNovidades,
  TETO_DA_MEMORIA,
} from './deteccaoDeMudanca';

const SP = 'America/Sao_Paulo';

describe('separarNovidades', () => {
  it('linha nunca vista é novidade e entra na memória', () => {
    const r = separarNovidades([{ impressao: 'a', carimbo: '2026-10-09T10:00:00' }], {}, '2026-10-09T09:50:00');
    expect(r.novas.map((n) => n.impressao)).toEqual(['a']);
    expect(r.vistos).toEqual({ a: '2026-10-09T10:00:00' });
  });

  it('a mesma linha devolvida pela sobreposição da janela NÃO é novidade', () => {
    // É o caso de toda volta: a consulta tem folga e repete o que já viu.
    const vistos = { a: '2026-10-09T10:00:00' };
    const r = separarNovidades([{ impressao: 'a', carimbo: '2026-10-09T10:00:00' }], vistos, '2026-10-09T09:55:00');
    expect(r.novas).toEqual([]);
  });

  it('conteúdo alterado tem impressão nova, e por isso É novidade', () => {
    const vistos = { [impressaoDe('SALUNO', { RA: '1', NOME: 'Ana' })]: '2026-10-09T10:00:00' };
    const alterada = impressaoDe('SALUNO', { RA: '1', NOME: 'Ana Maria' });
    const r = separarNovidades([{ impressao: alterada, carimbo: '2026-10-09T10:01:00' }], vistos, '2026-10-09T09:55:00');
    expect(r.novas).toHaveLength(1);
  });

  it('esquece o que ficou para trás do desde', () => {
    const vistos = { velha: '2026-10-09T08:00:00', recente: '2026-10-09T10:00:00' };
    const r = separarNovidades([], vistos, '2026-10-09T09:00:00');
    expect(r.vistos).toEqual({ recente: '2026-10-09T10:00:00' });
  });

  it('renova o carimbo de quem continua voltando na consulta', () => {
    // Fonte sem coluna de modificação e RM adiantado: a linha segue voltando
    // depois que o nosso carimbo dela envelheceu. Sem renovar, ela seria
    // esquecida e redetectada como nova a cada folga.
    const vistos = { a: '2026-10-09T10:00:00' };
    const r = separarNovidades([{ impressao: 'a', carimbo: '2026-10-09T10:15:00' }], vistos, '2026-10-09T10:05:00');
    expect(r.novas).toEqual([]);
    expect(r.vistos.a).toBe('2026-10-09T10:15:00');
  });

  it('quem PAROU de voltar envelhece e sai da memória', () => {
    const vistos = { a: '2026-10-09T10:00:00' };
    const r = separarNovidades([], vistos, '2026-10-09T10:05:00');
    expect(r.vistos).toEqual({});
  });

  it('duplicata dentro da mesma volta conta uma vez só', () => {
    const l = { impressao: 'a', carimbo: '2026-10-09T10:00:00' };
    expect(separarNovidades([l, l], {}, '2026-10-09T09:00:00').novas).toHaveLength(1);
  });

  it('a memória tem teto e mantém as mais recentes', () => {
    const vistos: Record<string, string> = {};
    for (let i = 0; i < TETO_DA_MEMORIA + 10; i += 1) {
      vistos[`k${i}`] = `2026-10-09T10:${String(Math.floor(i / 1000)).padStart(2, '0')}:00.${String(i).padStart(6, '0')}`;
    }
    const r = separarNovidades([], vistos, '2026-10-09T00:00:00');
    expect(Object.keys(r.vistos)).toHaveLength(TETO_DA_MEMORIA);
    expect(r.vistos.k0).toBeUndefined();
  });
});

describe('impressaoDe', () => {
  it('não depende da ordem das chaves', () => {
    expect(impressaoDe('X', { a: 1, b: 2 })).toBe(impressaoDe('X', { b: 2, a: 1 }));
  });
  it('o prefixo separa fontes que teriam o mesmo conteúdo', () => {
    expect(impressaoDe('SALUNO', { a: 1 })).not.toBe(impressaoDe('PPESSOA', { a: 1 }));
  });
});

describe('maiorCarimbo', () => {
  it('compara como texto no mesmo formato, e undefined perde', () => {
    expect(maiorCarimbo('2026-09-09 19:59:07', '2026-09-09 19:59:07.753454')).toBe('2026-09-09 19:59:07.753454');
    expect(maiorCarimbo(undefined, 'x')).toBe('x');
    expect(maiorCarimbo('x', undefined)).toBe('x');
  });
});

describe('dentroDoHorario', () => {
  // 13:00 em São Paulo = 16:00Z
  const meioDia = new Date('2026-10-09T16:00:00Z');
  const madrugada = new Date('2026-10-09T06:30:00Z'); // 03:30 em SP

  it('janela normal', () => {
    expect(dentroDoHorario(meioDia, SP, 6, 22)).toBe(true);
    expect(dentroDoHorario(madrugada, SP, 6, 22)).toBe(false);
  });

  it('o fim é exclusivo: às 22:00 a janela 6–22 já fechou', () => {
    expect(dentroDoHorario(new Date('2026-10-10T01:00:00Z'), SP, 6, 22)).toBe(false);
  });

  it('início igual ao fim é o dia inteiro', () => {
    expect(dentroDoHorario(madrugada, SP, 0, 0)).toBe(true);
  });

  it('janela que atravessa a meia-noite', () => {
    expect(dentroDoHorario(madrugada, SP, 22, 6)).toBe(true);
    expect(dentroDoHorario(meioDia, SP, 22, 6)).toBe(false);
  });

  it('meia-noite é hora 0, não 24', () => {
    expect(dentroDoHorario(new Date('2026-10-10T03:00:00Z'), SP, 0, 6)).toBe(true);
  });
});

describe('instanteNoFuso', () => {
  it('produz o formato do RECMODIFIEDON, no relógio de São Paulo', () => {
    expect(instanteNoFuso(new Date('2026-10-09T16:05:09Z'), SP)).toBe('2026-10-09T13:05:09');
  });
  it('vira o dia no fuso, não em UTC', () => {
    expect(diaNoFuso(new Date('2026-10-10T01:00:00Z'), SP)).toBe('2026-10-09');
  });
});

describe('esperaAposFalha', () => {
  it('sem falha, o intervalo normal', () => {
    expect(esperaAposFalha(0, 60_000)).toBe(60_000);
  });
  it('dobra a cada falha', () => {
    expect(esperaAposFalha(1, 60_000)).toBe(120_000);
    expect(esperaAposFalha(3, 60_000)).toBe(480_000);
  });
  it('não passa de 15 minutos — a cópia de base dura horas, e insistir não ajuda', () => {
    expect(esperaAposFalha(20, 60_000)).toBe(ESPERA_MAXIMA_APOS_FALHA_MS);
  });
});

describe('recuarCarimboDoToddle', () => {
  it('recua no relógio de parede e devolve sem fração', () => {
    expect(recuarCarimboDoToddle('2026-09-09 20:00:29.170915', 10 * 60_000)).toBe('2026-09-09 19:50:29');
  });
  it('atravessa a meia-noite', () => {
    expect(recuarCarimboDoToddle('2026-09-10 00:05:00', 10 * 60_000)).toBe('2026-09-09 23:55:00');
  });
  it('carimbo ilegível volta sem recuo, em vez de virar "Invalid Date" no filtro', () => {
    expect(recuarCarimboDoToddle('lixo', 1000)).toBe('lixo');
  });
});

describe('recuarRelogioDeParede', () => {
  it('recua no formato do RECMODIFIEDON', () => {
    expect(recuarRelogioDeParede('2026-10-09T13:05:09', 10 * 60_000)).toBe('2026-10-09T12:55:09');
  });
});
