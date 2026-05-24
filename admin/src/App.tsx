import type { ReactElement } from 'react';
import { Link, NavLink, Route, Routes } from 'react-router-dom';

import LeadsPage from '@/pages/Leads';
import LeadDetailPage from '@/pages/LeadDetail';
import HumanActionsPage from '@/pages/HumanActions';
import AuditPage from '@/pages/Audit';

function navItemClass({ isActive }: { isActive: boolean }): string {
  return [
    'text-sm transition-colors',
    isActive ? 'text-slate-900 font-semibold' : 'text-slate-600 hover:text-slate-900',
  ].join(' ');
}

function Nav(): ReactElement {
  return (
    <nav className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-6 px-6 py-3">
        <Link to="/" className="text-sm font-semibold text-slate-900">
          F16 admin
        </Link>
        <NavLink to="/leads" className={navItemClass}>
          Leads
        </NavLink>
        <NavLink to="/queue" className={navItemClass}>
          File humaine
        </NavLink>
        <NavLink to="/audit" className={navItemClass}>
          Audit
        </NavLink>
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
          — soumissions récentes (web, WhatsApp, Meta). Clic sur une ligne pour le détail.
        </li>
        <li>
          <Link className="text-sky-700 hover:underline" to="/queue">
            File humaine
          </Link>{' '}
          — actions agent en attente de validation Ridaa/Achraf.
        </li>
        <li>
          <Link className="text-sky-700 hover:underline" to="/audit">
            Audit
          </Link>{' '}
          — journal forensic + export NDJSON conforme ACPR.
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
        <Route path="/leads/:id" element={<LeadDetailPage />} />
        <Route path="/queue" element={<HumanActionsPage />} />
        <Route path="/audit" element={<AuditPage />} />
      </Routes>
    </div>
  );
}
