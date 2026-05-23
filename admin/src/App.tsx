import type { ReactElement } from 'react';
import { Link, Route, Routes } from 'react-router-dom';

import LeadsPage from '@/pages/Leads';

function Nav(): ReactElement {
  return (
    <nav className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-6 px-6 py-3">
        <Link to="/" className="text-sm font-semibold text-slate-900">
          F16 admin
        </Link>
        <Link to="/leads" className="text-sm text-slate-600 hover:text-slate-900">
          Leads
        </Link>
      </div>
    </nav>
  );
}

function Home(): ReactElement {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-6">
      <h1 className="text-3xl font-semibold tracking-tight">F16 admin</h1>
      <p className="text-base text-muted-foreground">
        Autonomous AI organization for Assuryal Conseil. Choisis un onglet en haut pour commencer.
      </p>
      <ul className="list-inside list-disc text-sm text-slate-600">
        <li>
          <Link className="text-sky-700 hover:underline" to="/leads">
            Leads
          </Link>{' '}
          — les soumissions récentes (formulaire web, WhatsApp, Meta).
        </li>
      </ul>
    </main>
  );
}

export default function App(): ReactElement {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Nav />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/leads" element={<LeadsPage />} />
      </Routes>
    </div>
  );
}
