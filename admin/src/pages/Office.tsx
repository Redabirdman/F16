// admin/src/pages/Office.tsx
import { useEffect, useRef, type ReactElement } from 'react';
import { OfficeScene } from '@/office/scene';

export default function OfficePage(): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    let scene: OfficeScene | null = new OfficeScene();
    let disposed = false;

    void scene.mount(host).then(() => {
      // StrictMode double-invokes effects in dev; if we were torn down
      // during the async mount, destroy immediately.
      if (disposed) scene?.destroy();
    });

    const onResize = (): void => scene?.handleResize(host);
    const onVisibility = (): void => {
      if (document.hidden) scene?.pause();
      else scene?.resume();
    };
    globalThis.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      globalThis.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      scene?.destroy();
      scene = null;
    };
  }, []);

  return (
    // 57px = navbar height (App.tsx)
    <div className="relative h-[calc(100vh-57px)] w-full overflow-hidden bg-slate-900">
      <div ref={hostRef} className="absolute inset-0" />
      <div className="pointer-events-none absolute left-4 top-4 rounded-md bg-slate-900/70 px-3 py-1.5 text-xs font-medium text-slate-200">
        Bureau F16 — vue live
      </div>
    </div>
  );
}
