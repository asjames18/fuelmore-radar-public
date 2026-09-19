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
