/// <reference lib="webworker" />
import { registerAllExtensions } from '../media/extensions'
import { runJob, JobCanceledError } from '../media/jobs'

const scope = self

registerAllExtensions()
let controller = null

scope.onmessage = (e) => {
  const msg = e.data
  if (msg.type === 'cancel') {
    controller?.abort()
    return
  }
  controller = new AbortController()
  runJob(msg.job, {
    signal: controller.signal,
    onProgress: (p) => scope.postMessage({ type: 'progress', ...p }),
  }).then(
    (result) => scope.postMessage({ type: 'done', result }, result.buffer ? [result.buffer] : []),
    (err) =>
      scope.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
        canceled: err instanceof JobCanceledError,
      }),
  )
}

scope.postMessage({ type: 'ready', at: performance.timeOrigin + performance.now() })
