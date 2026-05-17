import { describe, it, expect } from 'vitest';
import { app } from '../src/index.js';

describe('GET /health', () => {
  it('returns 200 with service health payload', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      ok: boolean;
      service: string;
      version: string;
      uptime: number;
    };

    expect(body.ok).toBe(true);
    expect(body.service).toBe('f16-backend');
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
    expect(typeof body.uptime).toBe('number');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });
});
