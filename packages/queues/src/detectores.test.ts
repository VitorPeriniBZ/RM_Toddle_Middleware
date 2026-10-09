import { describe, expect, it } from 'vitest';
import {
  DETECTORES_EM_ORDEM, PREFIXO_DO_DISPARO_CONTINUO, RITMO_POR_FLUXO, decidirDisparo, planejarInicio, type JobNaFila,
} from './detectores';
import { FLOW, FLUXOS } from './fluxos';

const JOB = 'term-grades.sync';

describe('decidirDisparo — no máximo um rodando e um esperando', () => {
  it('fila vazia: enfileira', () => {
    expect(decidirDisparo([], JOB)).toBe('enfileirar');
  });

  it('um ESPERANDO absorve o pedido: ele ainda não leu nada e vai ler o estado novo', () => {
    const jobs: JobNaFila[] = [{ nome: JOB, estado: 'waiting' }];
    expect(decidirDisparo(jobs, JOB)).toBe('ja-na-fila');
  });

  it('um RODANDO não absorve: ele pode ter lido a origem antes da mudança', () => {
    const jobs: JobNaFila[] = [{ nome: JOB, estado: 'active' }];
    expect(decidirDisparo(jobs, JOB)).toBe('enfileirar');
  });

  it('rodando + esperando: absorve', () => {
    const jobs: JobNaFila[] = [
      { nome: JOB, estado: 'active' },
      { nome: JOB, estado: 'waiting' },
    ];
    expect(decidirDisparo(jobs, JOB)).toBe('ja-na-fila');
  });

  it('o marcador do próximo cron NÃO é trabalho pendente', () => {
    const jobs: JobNaFila[] = [{ nome: JOB, estado: 'delayed', repeatJobKey: 'term-grades.sync' }];
    expect(decidirDisparo(jobs, JOB)).toBe('enfileirar');
  });

  it('job em backoff entre tentativas conta como esperando', () => {
    const jobs: JobNaFila[] = [{ nome: JOB, estado: 'delayed' }];
    expect(decidirDisparo(jobs, JOB)).toBe('ja-na-fila');
  });

  it('lote do fan-out de alunos não substitui uma leitura nova do RM', () => {
    const jobs: JobNaFila[] = [{ nome: 'students.upsert-batch', estado: 'waiting' }];
    expect(decidirDisparo(jobs, 'students.extract')).toBe('enfileirar');
  });
});

describe('o catálogo de detectores', () => {
  it('todo fluxo disparado existe no catálogo de fluxos', () => {
    for (const d of DETECTORES_EM_ORDEM) {
      for (const f of d.fluxos) expect(FLUXOS[f]).toBeDefined();
    }
  });

  it('o padrão respeita o piso e o teto que o banco impõe (30s–1h)', () => {
    for (const d of DETECTORES_EM_ORDEM) {
      expect(d.padrao.intervaloSegundos).toBeGreaterThanOrEqual(30);
      expect(d.padrao.intervaloSegundos).toBeLessThanOrEqual(3600);
    }
  });

  it('o id do disparo tem exatamente 3 partes separadas por ":" — o único formato que o BullMQ aceita', () => {
    for (const d of DETECTORES_EM_ORDEM) {
      for (const f of d.fluxos) {
        expect(`${PREFIXO_DO_DISPARO_CONTINUO}${f}:${Date.now()}`.split(':')).toHaveLength(3);
      }
    }
  });
});

describe('planejarInicio — agrupa a rajada', () => {
  const T = 1_000_000_000;
  const notas = RITMO_POR_FLUXO[FLOW.NOTAS];

  it('sem passada anterior, começa agora', () => {
    expect(planejarInicio(T, null, notas)).toBe(T);
  });

  it('passada anterior recente empurra para depois do espaçamento', () => {
    expect(planejarInicio(T, T - 60_000, notas)).toBe(T - 60_000 + notas.espacamentoMs);
  });

  it('passada anterior antiga não segura nada', () => {
    expect(planejarInicio(T, T - 3_600_000, notas)).toBe(T);
  });

  it('professores esperam 30 min depois da mudança — criar staff é irreversível', () => {
    expect(planejarInicio(T, null, RITMO_POR_FLUXO[FLOW.PROFESSORES])).toBe(T + 30 * 60_000);
  });

  it('todo fluxo do catálogo tem ritmo', () => {
    for (const k of Object.keys(FLUXOS)) expect(RITMO_POR_FLUXO[k as keyof typeof RITMO_POR_FLUXO]).toBeDefined();
  });
});
