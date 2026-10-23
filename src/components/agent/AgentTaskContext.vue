<script setup lang="ts">
import { computed } from 'vue'
import { agentM1Copy } from '@/services/agent-m1-copy'
import { agentM2Copy } from '@/services/agent-m2-copy'
import type { AgentContextRead, AgentTaskContext } from '@/services/agent-context'

const props = defineProps<{ task: AgentTaskContext; reads?: AgentContextRead[]; locale: string }>()
const text = (key: Parameters<typeof agentM1Copy>[1], params?: Record<string, string | number>) => agentM1Copy(props.locale, key, params)
function readLabel(read: AgentContextRead): string {
  const key = read.kind === 'outline' ? 'readOutline' : read.kind === 'range' ? 'readRange' : read.kind === 'search' ? 'readSearch' : read.kind === 'citation' ? 'readCitation' : read.kind === 'summary' ? 'readSummary' : read.kind === 'skill' ? 'readSkill' : 'readReview'
  return text(key)
}
function rangeLabel(read: AgentContextRead): string {
  return read.startLine && read.endLine ? text('lineRange', { start: read.startLine, end: read.endLine }) : ''
}
function taskStatus(): string {
  const key = `status${props.task.status[0]!.toUpperCase()}${props.task.status.slice(1)}` as Parameters<typeof agentM1Copy>[1]
  return text(key)
}
const retrieved = computed(() => (props.reads ?? []).filter(read => read.tool === 'search_document'))
const actuallyRead = computed(() => (props.reads ?? []).filter(read => read.tool !== 'search_document'))
const m2 = (key: Parameters<typeof agentM2Copy>[1]) => agentM2Copy(props.locale, key)
</script>

<template>
  <details class="agent-task-context">
    <summary>{{ text('contextTitle') }} · {{ taskStatus() }} · <span v-if="task.readOnly" class="agent-context-readonly">{{ m2('modelCheckReadOnly') }} · </span>{{ task.localModel ? text('modelLocal') : text('modelRemote') }} · {{ task.model || task.endpoint }}</summary>
    <p class="agent-context-route"><strong>{{ task.model || task.endpoint }}</strong> · {{ task.endpoint }}<br>{{ text('promptSent') }} {{ text('documentOnDemand') }}</p>
    <p v-if="!task.sources.length" class="agent-context-empty">{{ text('noContext') }}</p>
    <ul v-else class="agent-context-sources">
      <li v-for="source in task.sources" :key="source.documentId">
        <span>{{ source.kind === 'current' ? text('current') : text('reference') }}</span>
        <strong>{{ source.name }}</strong>
        <small v-if="source.kind === 'current'">{{ text(task.scope === 'selection' ? 'scopeSelection' : task.scope === 'document' ? 'scopeDocument' : 'scopeNone') }}</small>
      </li>
    </ul>
    <section v-if="task.skills.length" class="agent-context-skill-list">
      <strong>{{ text('availableSkills') }}</strong>
      <ul><li v-for="skill in task.skills" :key="skill.id"><span>{{ skill.name }}</span><small>{{ text(skill.selected ? 'selectedSkill' : 'availableSkill') }}</small></li></ul>
    </section>
    <section class="agent-context-reads agent-context-retrieved">
      <strong>{{ m2('retrievedResults') }}</strong>
      <p v-if="!retrieved.length" class="agent-context-empty">{{ m2('noRetrievedResults') }}</p>
      <details v-for="read in retrieved" :key="read.id" class="agent-context-read">
        <summary>
          {{ readLabel(read) }} · {{ read.documentName }}
          <template v-if="rangeLabel(read)"> · {{ rangeLabel(read) }}</template>
          <template v-if="read.resultCount !== undefined"> · {{ text('matches', { count: read.resultCount }) }}</template>
        </summary>
        <small v-if="read.query" class="agent-context-query">{{ read.query }}</small>
        <small v-if="read.field" class="agent-context-query">{{ read.field }}</small>
        <pre>{{ read.excerpt }}</pre>
        <small v-if="read.truncated" class="agent-context-truncated">{{ text('previewTruncated') }}</small>
      </details>
    </section>
    <section class="agent-context-reads agent-context-actual-reads">
      <strong>{{ m2('actualReads') }}</strong>
      <p v-if="!actuallyRead.length" class="agent-context-empty">{{ m2('noActualReads') }}</p>
      <details v-for="read in actuallyRead" :key="read.id" class="agent-context-read">
        <summary>
          {{ readLabel(read) }} · {{ read.documentName }}
          <template v-if="rangeLabel(read)"> · {{ rangeLabel(read) }}</template>
          <template v-if="read.resultCount !== undefined"> · {{ text('matches', { count: read.resultCount }) }}</template>
        </summary>
        <small v-if="read.query" class="agent-context-query">{{ read.query }}</small>
        <small v-if="read.field" class="agent-context-query">{{ read.field }}</small>
        <pre>{{ read.excerpt }}</pre>
        <small v-if="read.truncated" class="agent-context-truncated">{{ text('previewTruncated') }}</small>
      </details>
    </section>
  </details>
</template>
