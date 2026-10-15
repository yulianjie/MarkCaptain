import { compileNoteQuery, QueryError } from './structured-search'
import type { NoteAnalysis } from './note-index'
interface SearchRequest { id: number; query?: string; notes?: NoteAnalysis[]; cancel?: boolean }
let activeId = 0
self.onmessage = async (event: MessageEvent<SearchRequest>) => {
  const { id } = event.data
  activeId = id
  if (event.data.cancel) return
  const { query = '', notes = [] } = event.data
  try {
    const matches = compileNoteQuery(query)
    const paths: string[] = []
    let total = 0
    for (let i = 0; i < notes.length; i += 256) {
      if (activeId !== id) return
      for (const note of notes.slice(i, i + 256)) {
        if (matches(note)) {
          total++
          if (paths.length < 1000) paths.push(note.relative)
        }
      }
      // Let newer searches and explicit cancellation requests update activeId.
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    if (activeId === id) self.postMessage({ id, paths, total })
  } catch (e) {
    if (activeId === id) self.postMessage({ id, error: e instanceof QueryError ? e.key : 'notes.queryOperator', detail: e instanceof QueryError ? e.detail : String(e) })
  }
}
