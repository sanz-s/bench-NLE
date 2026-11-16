import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Cross-origin isolation is required so the Mediabunny extension WASM can use
// shared-memory threads (SharedArrayBuffer). Without it the benchmarks are skewed.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

const BENCH_SERVER = process.env.BENCH_SERVER ?? 'http://127.0.0.1:5199'

/**
 * Same-origin bridge to the OPTIONAL bench-server (CPU/GPU sampler), so calls work under COEP.
 * Unlike Vite's proxy it stays silent when the server isn't running (answers 503), because the
 * editor polls it and must work fully without it.
 */
function benchApiBridge() {
  const handler = (req, res, next) => {
    if (!req.url?.startsWith('/bench-api/')) return next()
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      try {
        const r = await fetch(BENCH_SERVER + req.url.slice('/bench-api'.length), {
          method: req.method,
          headers: { 'content-type': 'application/json' },
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
          signal: AbortSignal.timeout(5000),
        })
        res.statusCode = r.status
        res.setHeader('content-type', r.headers.get('content-type') ?? 'application/json')
        res.end(Buffer.from(await r.arrayBuffer()))
      } catch {
        res.statusCode = 503
        res.setHeader('content-type', 'application/json')
        res.end('{"ok":false,"error":"bench-server not running"}')
      }
    })
  }
  return {
    name: 'bench-api-bridge',
    configureServer: (server) => void server.middlewares.use(handler),
    configurePreviewServer: (server) => void server.middlewares.use(handler),
  }
}

export default defineConfig({
  plugins: [react(), benchApiBridge()],
  server: { port: 5173, headers: isolationHeaders },
  preview: { port: 4173, headers: isolationHeaders },
  worker: { format: 'es' },
  optimizeDeps: {
    // The extensions spawn their own inline workers / WASM; keep them out of pre-bundling.
    exclude: [
      '@mediabunny/aac-encoder',
      '@mediabunny/mp3-encoder',
      '@mediabunny/flac-encoder',
      '@mediabunny/prores',
      '@mediabunny/ac3',
      '@mediabunny/dts',
      '@mediabunny/truehd',
    ],
  },
})
