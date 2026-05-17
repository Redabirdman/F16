import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from 'react-error-boundary';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import App from '../src/App';
import { RootErrorFallback } from '../src/components/error-fallback';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distDir = join(__dirname, '..', 'dist');

afterEach(() => {
  cleanup();
});

function renderApp(): void {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('App (smoke)', () => {
  it('renders the "F16 admin" heading on /', () => {
    renderApp();
    const heading = screen.getByRole('heading', { level: 1, name: /f16 admin/i });
    expect(heading).toBeInTheDocument();
  });

  it('renders the subtitle', () => {
    renderApp();
    expect(
      screen.getByText(/autonomous ai organization for assuryal conseil/i),
    ).toBeInTheDocument();
  });

  it('renders a shadcn Button (proves shadcn is wired)', () => {
    renderApp();
    const button = screen.getByRole('button', { name: /get started/i });
    expect(button).toBeInTheDocument();
    // shadcn Button applies bg-primary class via cva variants
    expect(button.className).toMatch(/bg-primary/);
  });
});

describe('RootErrorFallback', () => {
  it('renders the fallback UI when a child throws', () => {
    // Suppress React's expected error console noise from the thrown error.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const Bomb = (): never => {
      throw new Error('boom: synthetic failure');
    };

    render(
      <ErrorBoundary FallbackComponent={RootErrorFallback}>
        <Bomb />
      </ErrorBoundary>,
    );

    expect(
      screen.getByRole('heading', { level: 1, name: /something went wrong/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/boom: synthetic failure/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();

    errSpy.mockRestore();
  });
});

// Build-artifact smoke check — only runs if `pnpm build` has produced dist/.
// Asserts the shape Caddy will serve in prod.
describe('build artifact (shape)', () => {
  it.skipIf(!existsSync(distDir))(
    'dist/index.html exists and references hashed JS + CSS assets under /assets',
    async () => {
      const indexPath = join(distDir, 'index.html');
      expect(existsSync(indexPath)).toBe(true);

      const { readFileSync } = await import('node:fs');
      const html = readFileSync(indexPath, 'utf8');

      // Vite emits hashed bundles under /assets/*.{js,css}
      expect(html).toMatch(/<script[^>]+src="\/assets\/[^"]+\.js"/);
      expect(html).toMatch(/<link[^>]+href="\/assets\/[^"]+\.css"/);
      expect(html).toContain('<div id="root">');

      // Sanity check: total dist size is a few hundred KB, NOT multi-MB.
      // Catches regressions where pixi.js / recharts get bundled into the
      // landing page by accident.
      const assetsDir = join(distDir, 'assets');
      expect(existsSync(assetsDir)).toBe(true);
      const { readdirSync } = await import('node:fs');
      const totalBytes = readdirSync(assetsDir)
        .map((f) => statSync(join(assetsDir, f)).size)
        .reduce((a, b) => a + b, 0);
      expect(totalBytes).toBeLessThan(2_000_000); // 2MB ceiling for a "/" route
    },
  );
});
