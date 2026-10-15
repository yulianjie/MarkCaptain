import { planReferenceMove } from './note-index'
self.onmessage = (event: MessageEvent<{ source: string; destination: string; documents: { relative: string; markdown: string }[] }>) => {
  try { const { source, destination, documents } = event.data; self.postMessage({ plan: planReferenceMove(source, destination, documents) }) }
  catch (e) { self.postMessage({ error: String(e) }) }
}
