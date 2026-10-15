import { planReferenceMove } from './note-index'
export function planMoveInBackground(source: string, destination: string, documents: readonly { relative: string; markdown: string }[], signal: AbortSignal): Promise<ReturnType<typeof planReferenceMove>> {
  if (signal.aborted) return Promise.reject(new Error('notes.changed'))
  if (typeof Worker === 'undefined') return Promise.resolve(planReferenceMove(source, destination, documents))
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./reference-plan.worker.ts', import.meta.url), { type: 'module' })
    const cleanup = () => { worker.terminate(); signal.removeEventListener('abort', cancel) }
    const cancel = () => { cleanup(); reject(new Error('notes.changed')) }
    worker.onmessage = event => { cleanup(); if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.plan) }
    worker.onerror = event => { cleanup(); reject(new Error(event.message)) }
    signal.addEventListener('abort', cancel, { once: true })
    worker.postMessage({ source, destination, documents: documents.map(d => ({ relative: d.relative, markdown: d.markdown })) })
  })
}
