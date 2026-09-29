import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/app/', plugins: [react(), {
    // Как nginx стенда: корень ведёт на вход, короткие ссылки — в приложение.
    name: 'root-redirects',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? '/').split('?')[0];
        if (path === '/') {
          response.writeHead(302, { Location: '/app/login' }); response.end(); return;
        }
        if (path === '/teacher' || path === '/admin') {
          response.writeHead(302, { Location: '/app' + path }); response.end(); return;
        }
        next();
      });
    },
  }],
  server: { port: 5173, strictPort: true, proxy: {
    '/api': { target: process.env.API_TARGET ?? 'http://127.0.0.1:8000', changeOrigin: true },
    '/ws': { target: process.env.API_TARGET ?? 'http://127.0.0.1:8000', ws: true },
  } },
});
