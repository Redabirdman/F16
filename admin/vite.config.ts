import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? 'dev'),
  },
  server: {
    port: 5173,
    strictPort: true,
    // Listen on 0.0.0.0 so the dev server is reachable from LAN
    // (useful for testing the 2D office UI on a phone/tablet).
    host: true,
    // Proxy backend HTTP + WebSocket so the admin uses relative URLs
    // (`/v1/...`, `/ws`) in dev and prod alike. This means no
    // `VITE_API_BASE_URL` / `VITE_WS_URL` env vars in the client bundle.
    proxy: {
      '/v1': { target: 'http://localhost:3001', changeOrigin: true },
      '/ws': { target: 'ws://localhost:3001', ws: true, changeOrigin: true },
    },
  },
  preview: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'esnext',
  },
});
