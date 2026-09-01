import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  css: {
    modules: {
      // Readable in devtools, hashed enough to stay unique.
      generateScopedName: '[name]__[local]___[hash:base64:5]',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    host: process.env.FRONTEND_HOST ?? '127.0.0.1',
    port: Number(process.env.FRONTEND_PORT ?? 3000),
    // The backend is behind nginx in production; mirror that in dev.
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.BACKEND_PORT ?? 8000}`,
        changeOrigin: true,
      },
    },
  },
})
