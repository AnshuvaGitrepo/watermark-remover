import { defineConfig } from 'vite';

// One-off build config: produces a single classic (non-module) script so
// standalone/index.html can be opened directly via file:// (double-click).
// Browsers refuse to resolve ES module imports under file://, so this bakes
// the @pilio/gemini-watermark-remover dependency and app code into one file.
// Rebuild with: npx vite build --config vite.standalone.config.js
export default defineConfig({
  build: {
    outDir: 'standalone',
    emptyOutDir: false,
    lib: {
      entry: 'standalone-src/main.js',
      formats: ['iife'],
      name: 'WatermarkRemoverStandalone',
      fileName: () => 'app.bundle.js'
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true
      }
    }
  }
});
