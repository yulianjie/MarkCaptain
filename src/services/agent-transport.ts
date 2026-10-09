import { agentCancel, agentGetConfig, agentSaveConfig, agentStart, agentTestConnection, agentListSkills, agentImportSkill, agentSetSkillEnabled, agentRemoveSkill, agentReadSkill } from './tauri-invoke'
import { listenTyped } from './tauri-bridge'
import type { AgentEvent, AgentRequest } from './agent'
import { agentHistorySettings, agentHistorySetEnabled, agentHistoryList, agentHistoryRead, agentHistoryWrite, agentHistoryDelete } from './tauri-invoke'

const desktop = () => '__TAURI_INTERNALS__' in window

export const agentTransport = {
  historySettings: () => desktop() ? agentHistorySettings() : Promise.resolve({ enabled: false }),
  historySetEnabled: (enabled: boolean) => desktop() ? agentHistorySetEnabled(enabled) : Promise.reject(new Error('agent:desktopOnly')),
  historyList: () => desktop() ? agentHistoryList() : Promise.resolve([]),
  historyRead: agentHistoryRead,
  historyWrite: agentHistoryWrite,
  historyDelete: agentHistoryDelete,
  getConfig: () => '__TAURI_INTERNALS__' in window ? agentGetConfig() : Promise.reject(new Error('agent:desktopOnly')),
  saveConfig: agentSaveConfig,
  testConnection: agentTestConnection,
  start: (request: AgentRequest) => agentStart({ ...request,
    context: request.context ? { ...request.context, snapshotId: request.context.snapshotId ?? request.requestId } : null }),
  cancel: agentCancel,
  listSkills: agentListSkills,
  importSkill: agentImportSkill,
  setSkillEnabled: agentSetSkillEnabled,
  removeSkill: agentRemoveSkill,
  readSkill: agentReadSkill,
  listen: (handler: (event: AgentEvent) => void) => listenTyped('mt://agent/event', handler),
}
