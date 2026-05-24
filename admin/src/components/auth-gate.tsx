/**
 * AuthGate (M14.T1 lite).
 *
 * On mount:
 *   1. Probe a cheap admin endpoint (the dashboard KPI route).
 *   2. If it 401s, render the token entry form; on submit, persist the
 *      token via setAdminToken() and re-probe.
 *   3. If it 200s (token set OR backend in dev mode with no token
 *      requirement), render children.
 *
 * The component re-probes whenever the token changes so a fresh paste
 * surfaces success/failure immediately rather than waiting for a page
 * navigation.
 */
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { getAdminToken, setAdminToken } from '@/lib/api';

type ProbeState = 'unknown' | 'ok' | 'unauthorized' | 'error';

export function AuthGate({ children }: { children: ReactNode }): ReactElement {
  const [state, setState] = useState<ProbeState>('unknown');
  const [tokenInput, setTokenInput] = useState<string>(() => getAdminToken() ?? '');
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const probe = async (): Promise<void> => {
    try {
      const res = await fetch('/v1/admin/dashboard/kpis', {
        headers: tokenInput ? { Authorization: `Bearer ${tokenInput}` } : {},
        credentials: 'same-origin',
      });
      if (res.status === 401) {
        setState('unauthorized');
        setErrorDetail(null);
        return;
      }
      if (!res.ok) {
        setState('error');
        setErrorDetail(`HTTP ${res.status}`);
        return;
      }
      setState('ok');
      setErrorDetail(null);
    } catch (err) {
      setState('error');
      setErrorDetail(err instanceof Error ? err.message : String(err));
    }
  };

  // Initial probe — fires once on mount. The probe() closure captures
  // tokenInput; subsequent re-probes happen on form submit.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void probe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === 'unknown') {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Vérification de l&apos;accès…
      </div>
    );
  }

  if (state === 'ok') return <>{children}</>;

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <form
        className="flex w-full max-w-md flex-col gap-4 rounded-md border border-slate-200 bg-white p-6 shadow-sm"
        onSubmit={(e) => {
          e.preventDefault();
          setAdminToken(tokenInput);
          setState('unknown');
          void probe();
        }}
      >
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Accès F16 admin</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {state === 'unauthorized'
              ? "Saisis le jeton d'accès admin (ADMIN_BEARER_TOKEN)."
              : `Backend injoignable : ${errorDetail ?? 'erreur inconnue'}`}
          </p>
        </div>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          className="rounded border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-sky-500 focus:outline-none"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder="••••••••••••••••"
        />
        <div className="flex items-center justify-between">
          <Button type="submit" variant="default">
            Connexion
          </Button>
          <button
            type="button"
            className="text-xs text-slate-500 hover:text-slate-800"
            onClick={() => {
              setAdminToken('');
              setTokenInput('');
              setState('unauthorized');
            }}
          >
            Effacer le jeton stocké
          </button>
        </div>
      </form>
    </div>
  );
}
