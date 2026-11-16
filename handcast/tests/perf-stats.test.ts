import { describe, expect, it } from 'vitest';
import { PerfStats } from '../src/hc/perf-stats.js';

describe('PerfStats', () => {
  it('reports per-board percentiles, missed frames and first-solve times', () => {
    const s = new PerfStats();
    s.event('enter');
    s.event('placed', 'hand on table');
    s.event('board', 'prologue-1');
    for (let i = 0; i < 900; i++) s.frame(1 / 90, 90);
    s.event('cast', 'right');
    for (let i = 0; i < 100; i++) s.frame(i % 10 === 0 ? 1 / 45 : 1 / 90, 90);
    s.event('solved', 'prologue-1');
    s.event('board', 'prologue-2');
    for (let i = 0; i < 90; i++) s.frame(1 / 72, 72);
    s.event('loss', 'right');
    s.event('loss', 'left');
    s.event('loss', 'right');
    s.event('rate', '90->72');

    const text = s.summary('HEADER');
    const lines = text.split('\n');
    expect(lines[0]).toBe('HEADER');
    const p1 = lines.find((l) => l.startsWith('prologue-1'))!;
    const p2 = lines.find((l) => l.startsWith('prologue-2'))!;
    // 10 of 1000 frames took two vsyncs: 1.0% missed, solved after 1000/90 s.
    expect(p1).toMatch(/1\.0%/);
    expect(p1).toMatch(/0:11$/);
    expect(p2).toMatch(/0\.0%/);
    expect(p2).toMatch(/ -$/);
    expect(text).toMatch(/tracking lost: right 2, left 1/);
    expect(text).toMatch(/rate: 90->72 Hz @0:12/);
    expect(text).toMatch(/first minutes: bench 0:00 \(hand on table\), first glass 0:10, first solve 0:11/);
  });

  it('gives live fps and p95 over the recent window', () => {
    const s = new PerfStats();
    for (let i = 0; i < 300; i++) s.frame(i % 20 === 0 ? 0.03 : 1 / 90, 90);
    const live = s.recentStats(90);
    expect(live.fps).toBeGreaterThan(80);
    expect(live.fps).toBeLessThan(90);
    expect(live.missed).toBeCloseTo(0.05, 2);
    expect(live.p95).toBeGreaterThan(11);
  });

  it('caps the event log', () => {
    const s = new PerfStats();
    for (let i = 0; i < 2000; i++) s.event('cast');
    expect(s.events.length).toBeLessThanOrEqual(600);
  });
});
