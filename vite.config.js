import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5181,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001'
        // changeOrigin deliberately omitted: the backend's same-origin check
        // (server/index.js) relies on the Host header staying as the browser
        // sent it (localhost:5181), not rewritten to the proxy target.
      }
    }
  }
});
