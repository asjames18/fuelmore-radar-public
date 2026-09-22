import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => ({
  plugins: [react(), {
    name: 'radar-public-entry',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return mode === 'public' ? html : html
      },
    },
  }],
  build: { outDir: mode === 'public' ? 'dist-public' : 'dist' },
  // Export candidates land in gitignored public-export/ between releases;
  // never let their copied tests pollute the suite.
  test: { exclude: ['**/node_modules/**', '**/dist/**', '**/dist-public/**', 'public-export/**', '**/cypress/**', '**/.{idea,git,cache,output,temp}/**', '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*'] },
  server: {
    port: 4173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:4174',
      '/rpc': {
        target: 'https://rpc.mainnet.chain.robinhood.com',
        changeOrigin: true,
        rewrite: () => '/',
      },
    },
  },
  preview: {
    proxy: {
      '/api': 'http://127.0.0.1:4174',
      '/rpc': {
        target: 'https://rpc.mainnet.chain.robinhood.com',
        changeOrigin: true,
        rewrite: () => '/',
      },
    },
  },
}))
