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
describe('build artifact (shape)', () => {
  it.skipIf(!existsSync(distDir))(
    'index.html references a lean entry chunk; pixi is code-split into its own chunk',
    async () => {
      const indexPath = join(distDir, 'index.html');
      expect(existsSync(indexPath)).toBe(true);

      const { readFileSync, readdirSync } = await import('node:fs');
      const html = readFileSync(indexPath, 'utf8');
      expect(html).toMatch(/<script[^>]+src="\/assets\/[^"]+\.js"/);
      expect(html).toMatch(/<link[^>]+href="\/assets\/[^"]+\.css"/);
      expect(html).toContain('<div id="root">');

      const assetsDir = join(distDir, 'assets');
      expect(existsSync(assetsDir)).toBe(true);
      const files = readdirSync(assetsDir);

      // The ENTRY chunk (referenced directly by index.html) must stay lean:
      // pixi/recharts must NOT be bundled into it.
      const entryMatch = html.match(/<script[^>]+src="\/assets\/([^"]+\.js)"/);
      expect(entryMatch).not.toBeNull();
      const entryFile = entryMatch?.[1] ?? '';
      expect(entryFile).not.toBe('');
      const entryBytes = statSync(join(assetsDir, entryFile)).size;
      expect(entryBytes).toBeLessThan(800_000); // ~lean entry; pixi lives elsewhere

      // A separate (lazy) chunk must carry the office/pixi code.
      const hasLazyChunk = files.some(
        (f) => /Office|pixi|index-[A-Za-z0-9_-]+\.js/.test(f) && f !== entryFile,
      );
      expect(hasLazyChunk).toBe(true);
    },
  );
});
