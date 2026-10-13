import { toCssVariables } from '@ogc/ui';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const TOKENS_ID = 'virtual:ogc-tokens.css';
const RESOLVED_TOKENS_ID = `\0${TOKENS_ID}`;

/**
 * Emits the @ogc/ui design tokens as a real CSS file at build time, so styles
 * use `var(--ogc-*)` and no inline <style> is needed (keeps CSP strict).
 */
function ogcTokens(): Plugin {
  return {
    name: 'ogc-tokens',
    resolveId: (id) => (id === TOKENS_ID ? RESOLVED_TOKENS_ID : undefined),
    load: (id) => (id === RESOLVED_TOKENS_ID ? toCssVariables() : undefined),
  };
}

export default defineConfig({
  plugins: [react(), ogcTokens()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // ws: realtime (Socket.IO) is served under /api/realtime by the API.
      '/api': { target: 'http://localhost:3000', changeOrigin: false, ws: true },
    },
  },
  build: {
    sourcemap: true,
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
