import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import { resolve } from 'path';

const r = (p: string) => resolve(__dirname, p);

export default defineConfig({
  resolve: {
    alias: {
      '@': r('src/renderer'),
      '@shared': r('src/shared'),
    },
  },
  root: r('src/renderer'),
  base: './',
  build: {
    outDir: r('dist'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
  plugins: [
    react(),
    electron([
      {
        // 主进程入口（绝对路径）
        entry: r('src/main/index.ts'),
        vite: {
          build: {
            outDir: r('dist-electron/main'),
            sourcemap: true,
            rollupOptions: {
              external: [/^@devicefarmer\/adbkit/, 'electron', 'bluebird', 'debug', 'split', 'node-forge', 'app-info-parser'],
            },
          },
        },
      },
      {
        // preload 脚本（绝对路径）
        entry: r('src/preload/index.ts'),
        onstart(options) {
          options.reload();
        },
        vite: {
          build: {
            outDir: r('dist-electron/preload'),
            sourcemap: true,
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
    ]),
    renderer(),
  ],
});
