import { analyzeNote } from './note-index'
import type { NoteAnalysis } from './note-index'
export interface IndexRequest { id: number; documents: { relative: string; markdown: string }[] }
export interface IndexResponse { id: number; analyses: NoteAnalysis[]; error?: string }
let activeId = 0
self.onmessage = async (event: MessageEvent<IndexRequest>) => {
  const { id, documents } = event.data
  activeId = id
  try {
    const analyses: NoteAnalysis[] = []
    for (let i = 0; i < documents.length; i += 8) {
      if (activeId !== id) return
      analyses.push(...documents.slice(i, i + 8).map(d => analyzeNote(d.relative, d.markdown)))
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    if (activeId === id) self.postMessage({ id, analyses } satisfies IndexResponse)
  }
  catch (e) { self.postMessage({ id, analyses: [], error: String(e) } satisfies IndexResponse) }
}
