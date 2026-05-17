import type { ReactElement } from 'react';
import { Route, Routes } from 'react-router-dom';

import { Button } from '@/components/ui/button';

function Home(): ReactElement {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6 text-center text-foreground">
      <h1 className="text-5xl font-semibold tracking-tight sm:text-6xl">F16 admin</h1>
      <p className="max-w-xl text-base text-muted-foreground sm:text-lg">
        Autonomous AI organization for Assuryal Conseil
      </p>
      <Button variant="default" size="lg">
        Get started
      </Button>
    </main>
  );
}

export default function App(): ReactElement {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
    </Routes>
  );
}
