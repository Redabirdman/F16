/**
 * Zero-dependency metrics registry tests (M16). Fully hermetic — no Redis/DB.
 */
import { describe, it, expect } from 'vitest';
import { MetricsRegistry, registerDefaultMetrics } from '../../src/metrics/registry.js';

describe('MetricsRegistry', () => {
  it('renders a counter in Prometheus text format', async () => {
    const reg = new MetricsRegistry();
    const c = reg.counter('f16_jobs_completed_total', 'Jobs completed');
    c.inc({ queue: 'lead' });
    c.inc({ queue: 'lead' });
    c.inc({ queue: 'quote' }, 3);

    const out = await reg.render();
    expect(out).toContain('# TYPE f16_jobs_completed_total counter');
    expect(out).toContain('f16_jobs_completed_total{queue="lead"} 2');
    expect(out).toContain('f16_jobs_completed_total{queue="quote"} 3');
  });

  it('counters cannot decrease', () => {
    const reg = new MetricsRegistry();
    const c = reg.counter('f16_x_total', 'x');
    expect(() => c.inc({}, -1)).toThrowError(/cannot decrease/);
  });

  it('gauges support set / inc / dec, last-write-wins per label set', async () => {
    const reg = new MetricsRegistry();
    const g = reg.gauge('f16_queue_depth', 'depth');
    g.set({ queue: 'lead', state: 'wait' }, 5);
    g.set({ queue: 'lead', state: 'wait' }, 7); // overwrite
    g.inc({ queue: 'lead', state: 'active' });
    g.dec({ queue: 'lead', state: 'active' });

    const out = await reg.render();
    expect(out).toContain('f16_queue_depth{queue="lead",state="wait"} 7');
    expect(out).toContain('f16_queue_depth{queue="lead",state="active"} 0');
  });

  it('emits a zero base series for an empty metric', async () => {
    const reg = new MetricsRegistry();
    reg.counter('f16_empty_total', 'empty');
    const out = await reg.render();
    expect(out).toContain('f16_empty_total 0');
  });

  it('runs async collectors at render time', async () => {
    const reg = new MetricsRegistry();
    const g = reg.gauge('f16_live', 'live');
    let calls = 0;
    reg.registerCollector(async () => {
      calls += 1;
      g.set(42);
    });
    const out = await reg.render();
    expect(calls).toBe(1);
    expect(out).toContain('f16_live 42');
  });

  it('a throwing collector does not break the scrape', async () => {
    const reg = new MetricsRegistry();
    reg.counter('f16_ok_total', 'ok').inc();
    reg.registerCollector(() => {
      throw new Error('boom');
    });
    const out = await reg.render();
    expect(out).toContain('f16_ok_total 1');
  });

  it('rejects re-registering a name with a different type', () => {
    const reg = new MetricsRegistry();
    reg.counter('f16_dup', 'c');
    expect(() => reg.gauge('f16_dup', 'g')).toThrowError(/already registered/);
  });

  it('rejects an invalid metric name', () => {
    const reg = new MetricsRegistry();
    expect(() => reg.counter('1-bad name', 'x')).toThrowError(/invalid metric name/);
  });

  it('escapes quotes / backslashes / newlines in label values', async () => {
    const reg = new MetricsRegistry();
    reg.counter('f16_lbl_total', 'x').inc({ detail: 'a"b\\c\nd' });
    const out = await reg.render();
    expect(out).toContain('f16_lbl_total{detail="a\\"b\\\\c\\nd"} 1');
  });

  it('registerDefaultMetrics adds process gauges', async () => {
    const reg = new MetricsRegistry();
    registerDefaultMetrics(reg);
    const out = await reg.render();
    expect(out).toContain('f16_process_uptime_seconds');
    expect(out).toContain('f16_process_resident_memory_bytes');
    expect(out).toContain('f16_process_heap_used_bytes');
  });
});
