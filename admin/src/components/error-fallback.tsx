import type { FallbackProps } from 'react-error-boundary';

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function RootErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div
      role="alert"
      className="min-h-screen flex flex-col items-center justify-center p-8 gap-4 bg-background text-foreground"
    >
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <pre className="max-w-2xl whitespace-pre-wrap text-sm text-muted-foreground">
        {formatError(error)}
      </pre>
      <button
        onClick={resetErrorBoundary}
        className="px-4 py-2 rounded bg-primary text-primary-foreground hover:opacity-90"
      >
        Reload
      </button>
    </div>
  );
}
