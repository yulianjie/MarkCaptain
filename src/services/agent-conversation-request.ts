import type { ChatItem } from '@/stores/agent'
import { reviewExcerpt, reviewFeedback, type AgentImage, type AgentMessage, type AgentReviewChange } from './agent'

const bytes = (text: string) => new TextEncoder().encode(text).length
const MAX_REVIEW_BYTES = 16_000_000
const MAX_CHAT_BYTES = 220_000
const MAX_MESSAGE_BYTES = 80_000

/** Compact transport copies only. Local replies, patches, reasons and history stay intact. */
export function conversationRequest(items: ChatItem[], prompt: string, images: AgentImage[]) {
  const history = items.filter(item => !item.error && !item.cancelled)
  const reviewChanges: AgentReviewChange[] = []
  let reviewBytes = 0
  for (const item of [...history].reverse()) for (const change of item.edit?.changes ?? []) {
    const size = bytes(change.oldText) + bytes(change.newText) + bytes(change.reason ?? '')
    if (reviewBytes + size > MAX_REVIEW_BYTES || reviewChanges.length >= 384) continue
    reviewBytes += size
    reviewChanges.push({ id: change.id, oldText: change.oldText, newText: change.newText, ...(change.reason ? { reason: change.reason } : {}) })
  }
  const available = new Set(reviewChanges.map(change => change.id))
  const levels = [[512, 512, 80_000], [128, 256, 16_000], [0, 64, 2_000]] as const
  for (const [level, [excerptBudget, reasonBudget, replyBudget]] of levels.entries()) {
    let compacted = level > 0
    const messages: AgentMessage[] = history.map(item => {
      const feedback = item.edit ? reviewFeedback(item.edit, excerptBudget, reasonBudget, available) : ''
      if (item.edit?.changes.some(change => reviewExcerpt(change.oldText, excerptBudget) !== change.oldText || reviewExcerpt(change.newText, excerptBudget) !== change.newText || reviewExcerpt(change.reason ?? '', reasonBudget) !== (change.reason ?? ''))) compacted = true
      const omitted = item.imagesOmitted ? '\n[Images from this message were excluded from local history and are no longer available. Ask the user to reattach them if needed.]' : ''
      const marker = '\n[Earlier reply excerpt; full reply remains in the local conversation.]'
      const budget = Math.min(replyBudget, MAX_MESSAGE_BYTES - bytes(feedback + omitted + marker))
      const content = item.role === 'assistant' && bytes(item.content) > budget
        ? reviewExcerpt(item.content, Math.max(0, budget)) + marker : item.content
      if (content !== item.content) compacted = true
      return { role: item.role, content: content + omitted + feedback, ...(item.images?.length ? { images: item.images.map(image => ({ ...image })) } : {}) }
    })
    messages.push({ role: 'user', content: prompt.trim(), ...(images.length ? { images: images.map(image => ({ ...image })) } : {}) })
    if (messages.every(message => bytes(message.content) <= MAX_MESSAGE_BYTES) && messages.reduce((sum, message) => sum + bytes(message.content), 0) <= MAX_CHAT_BYTES) return { messages, reviewChanges, compacted }
  }
  throw new Error('agent:contextTooLarge')
}
