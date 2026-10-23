import type { AgentContextRead, AgentSource, DocumentSnapshot, ReviewedEdit } from './agent'

export type AgentMultiStage = 'idle' | 'preparing' | 'running' | 'review' | 'cancelled' | 'failed'
export type AgentMultiTargetStatus = 'waiting' | 'pending' | 'applied' | 'partial' | 'dismissed' | 'reverted' | 'conflict'
export interface AgentMultiTarget {
  documentId: string
  tabId: string
  name: string
  path?: string
  snapshot: DocumentSnapshot
  diskFingerprint: string | null
  diskContentHash: string | null
  proposal: ReviewedEdit | null
  status: AgentMultiTargetStatus
  error: string
}
export interface AgentMultiState {
  stage: AgentMultiStage
  requestId: string | null
  prompt: string
  answer: string
  error: string
  targets: AgentMultiTarget[]
  reads: AgentContextRead[]
  sources: AgentSource[]
  busy: boolean
  actionBusy: boolean
}

export function createAgentMultiState(): AgentMultiState {
  return { stage: 'idle', requestId: null, prompt: '', answer: '', error: '', targets: [], reads: [], sources: [], busy: false, actionBusy: false }
}
