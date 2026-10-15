import { relationsFromSource, type NoteRelations } from './note-relations'
import type { NoteAnalysis } from './note-index'
let active = 0
self.onmessage = async (event: MessageEvent<{ id: number; current: string; notes: NoteAnalysis[] }>) => {
  const { id, current, notes } = event.data; active = id
  const result: NoteRelations = { backlinks: [], mentions: [] }
  const target = notes.find(n => n.relative === current)
  if (target) for (let i = 0; i < notes.length; i += 8) {
    if (active !== id) return
    for (const source of notes.slice(i, i + 8)) { const relations = relationsFromSource(source, target, notes); result.backlinks.push(...relations.backlinks); result.mentions.push(...relations.mentions) }
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  if (active === id) self.postMessage({ id, result })
}
