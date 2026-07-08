import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock the API module so the page never hits the network during the smoke test.
vi.mock('@/lib/api', () => ({
  injectSimulatedLead: vi.fn(),
  resetSimulatedContact: vi.fn(),
  getSimStatus: vi.fn(async () => ({
    channels: { whatsapp: false, voice: false },
    contact: null,
  })),
}));

import SimulationPage from '@/pages/Simulation';

afterEach(() => {
  cleanup();
});

function renderPage(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/sim']}>
        <SimulationPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SimulationPage (smoke)', () => {
  it('renders the heading', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: /simulation/i })).toBeInTheDocument();
  });

  it('renders the core form fields (name, phone, channel radios)', () => {
    renderPage();
    expect(screen.getByText('Nom complet')).toBeInTheDocument();
    expect(screen.getByText('Téléphone')).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios.length).toBe(2);
    expect(screen.getByText('WhatsApp')).toBeInTheDocument();
    expect(screen.getByText('Appel')).toBeInTheDocument();
  });

  it('renders the Soumettre and Réinitialiser buttons', () => {
    renderPage();
    expect(screen.getByRole('button', { name: /soumettre/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /réinitialiser/i })).toBeInTheDocument();
  });
});
