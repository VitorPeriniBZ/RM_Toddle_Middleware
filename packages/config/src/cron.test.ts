import { describe, expect, it } from 'vitest';
import { TZ_AGENDA, validarCron } from './cron';

/**
 * A validação de cron é a única coisa entre a tela e um agendamento que ninguém
 * conferiu. Ela é pura de propósito — recebe texto e uma data, devolve veredito —
 * e por isso cabe na suíte que roda sem Postgres, sem Redis e sem rede.
 *
 * `agora` é FIXO em todos os casos. Prévia de disparo depende do instante, e
 * teste que depende do relógio de parede falha na virada do dia, longe de quem o
 * escreveu.
 */
const AGORA = new Date('2026-09-10T12:00:00-03:00');

describe('validarCron', () => {
  it('aceita cron de 5 campos e devolve cinco disparos', () => {
    const r = validarCron('0 3 * * *', AGORA);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proximos).toHaveLength(5);
    // Próximo 03:00 depois de 10/09 12:00 é 11/09 03:00, no fuso da escola.
    expect(r.proximos[0]).toBe('2026-09-11T03:00:00-03:00');
  });

  it('normaliza espaços em excesso', () => {
    const r = validarCron('  0   3  *  * *  ', AGORA);
    expect(r.ok && r.cron).toBe('0 3 * * *');
  });

  it('recusa 6 campos, porque o sexto é SEGUNDOS', () => {
    // O `cron-parser` aceitaria e o BullMQ obedeceria: um engano de formato
    // viraria job por segundo. A mensagem tem de dizer o que está errado, e não
    // só que o intervalo é curto.
    const r = validarCron('*/30 0 3 * * *', AGORA);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.erro).toContain('SEGUNDOS');
  });

  it('recusa contagem de campos diferente de 5', () => {
    expect(validarCron('0 3 *', AGORA).ok).toBe(false);
  });

  it('recusa expressão sintaticamente inválida', () => {
    const r = validarCron('banana 3 * * *', AGORA);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.erro).toContain('inválida');
  });

  it('recusa intervalo abaixo do mínimo', () => {
    // Com concurrency 1 isto não produz paralelismo: produz backlog crescente,
    // que aparece horas depois longe da causa. A guarda existe para o
    // `* * * * *` digitado por engano.
    const r = validarCron('* * * * *', AGORA);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.erro).toContain('abaixo do mínimo');
  });

  it('aceita o poll de meia em meia hora, que é o caso real da nota', () => {
    const r = validarCron('*/30 6-22 * * *', AGORA);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intervaloMinimoMinutos).toBe(30);
  });

  it('mede o menor intervalo, não o maior — lista de horas desigual', () => {
    // 03:00, 09:00, 12:00, 16:00 tem intervalos de 6h, 3h, 4h e 11h. O menor é o
    // que importa para a guarda, e é o que uma leitura ingênua da expressão
    // erraria.
    const r = validarCron('0 3,9,12,16 * * *', AGORA);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intervaloMinimoMinutos).toBe(180);
  });

  it('devolve horário no fuso da escola, com offset explícito', () => {
    // A UI mostra este texto. Sem o offset, o navegador de quem olha
    // reinterpretaria a string no fuso local dele — e a mesma tela mostraria
    // horários diferentes para pessoas diferentes.
    const r = validarCron('0 3 * * *', AGORA);
    expect(TZ_AGENDA).toBe('America/Sao_Paulo');
    expect(r.ok && r.proximos.every((p) => p.endsWith('-03:00'))).toBe(true);
  });
});
