import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@pd/core': path.resolve(__dirname, '../../packages/core/src'),
      '@pd/ai': path.resolve(__dirname, '../../packages/ai/src'),
    },
  },
  server: {
    port: 3000,
    allowedHosts: ['localhost', 'sb-3wqpb1x4cfpy.vercel.run', '.vercel.app', '.vusercontent.net'],
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
