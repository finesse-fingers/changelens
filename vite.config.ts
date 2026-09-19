import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

// The API port is configurable, so the dev proxy has to read the same value:
// pointing it at a literal means setting CHANGELENS_PORT moves the server and
// 502s every request the UI makes, with nothing to explain why.
const apiPort = Number(process.env.CHANGELENS_PORT ?? 4317);

export default defineConfig({
  root: 'src/web',
  plugins: [react(), tailwind()],
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: {
    port: 4316,
    proxy: {
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
    },
  },
});
