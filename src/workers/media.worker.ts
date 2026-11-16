/// <reference lib="webworker" />
import { registerAllExtensions } from '../media/extensions'
import { runJob, JobCanceledError } from '../media/jobs'
import type { MediaJob } from '../media/types'

export type WorkerRequest = { type: 'run'; job: MediaJob } | { type: 'cancel' }
export type WorkerResponse =
  | { type: 'ready'; at: number }
  | { type: 'progress'; progress: number; processedTime: number }
  | { type: 'done'; result: import('../media/types').JobResult }
  | { type: 'error'; message: string; canceled: boolean }

const scope = self as unknown as {
  postMessage(msg: WorkerResponse, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null
}

registerAllExtensions()
let controller: AbortController | null = null

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
    (err: unknown) =>
      scope.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
        canceled: err instanceof JobCanceledError,
      }),
  )
}

scope.postMessage({ type: 'ready', at: performance.timeOrigin + performance.now() })
