<script setup lang="ts">
import { computed, watch } from 'vue'
import { useAgentStore } from '@/stores/agent'
import { useEditorStore } from '@/stores/editor'
import { useI18n } from '@/i18n'
import { agentM2Copy } from '@/services/agent-m2-copy'
import { cleanLines } from '@/services/agent-m2'

const agent = useAgentStore()
const editor = useEditorStore()
const { locale } = useI18n()
const text = (key: Parameters<typeof agentM2Copy>[1], params?: Record<string, string | number>) => agentM2Copy(locale.value, key, params)
const includeText = computed({
  get: () => agent.conversation.projectAccess.include.join('\n'),
  set: value => { agent.conversation.projectAccess.include = cleanLines(value.split(/\r?\n/), ['**/*.md']) },
})
const excludeText = computed({
  get: () => agent.conversation.projectAccess.exclude.join('\n'),
  set: value => { agent.conversation.projectAccess.exclude = cleanLines(value.split(/\r?\n/)) },
})
const approvedQueriesText = computed({
  get: () => agent.conversation.webResearch.approvedQueries.join('\n'),
  set: value => { agent.conversation.webResearch.approvedQueries = cleanLines(value.split(/\r?\n/)) },
})
const urlsText = computed({
  get: () => agent.conversation.webResearch.urls.join('\n'),
  set: value => { agent.conversation.webResearch.urls = cleanLines(value.split(/\r?\n/)) },
})
const glossary = computed(() => agent.projectConfig.writing?.glossary ?? [])
watch(() => [agent.projectConfigRoot, agent.projectConfig.projectSearch?.include?.join('\n'), agent.projectConfig.projectSearch?.exclude?.join('\n')], () => {
  const access = agent.conversation.projectAccess
  if (!access.grantId && agent.projectConfig.projectSearch?.include?.length) access.include = [...agent.projectConfig.projectSearch.include]
  if (!access.grantId && agent.projectConfig.projectSearch?.exclude) access.exclude = [...agent.projectConfig.projectSearch.exclude]
}, { immediate: true })
function setGlossary(next: typeof glossary.value) {
  agent.projectConfig.writing ??= {}
  agent.projectConfig.writing.glossary = next
}
function addTerm() { setGlossary([...glossary.value, { preferred: '', avoid: [] }]) }
function removeTerm(index: number) { setGlossary(glossary.value.filter((_, current) => current !== index)) }
function updateAvoid(index: number, value: string) {
  const terms = [...glossary.value]
  const term = terms[index]
  if (term) terms[index] = { ...term, avoid: cleanLines(value.split(/\r?\n/)) }
  setGlossary(terms)
}
function setWebResearchEnabled(event: Event) {
  const enabled = (event.target as HTMLInputElement).checked
  agent.conversation.webResearch.enabled = enabled
  if (!enabled) agent.conversation.webResearch.publicDns = false
}
</script>

<template>
  <div class="agent-m2-controls">
    <details class="agent-m2-section">
      <summary>{{ text('projectTitle') }} · {{ agent.conversation.projectAccess.grantId ? text('grantActive') : text('grantInactive') }}</summary>
      <p class="agent-m2-hint">{{ agent.projectConfigRoot || text('noProject') }}</p>
      <template v-if="agent.projectConfigRoot">
        <p>{{ text('projectSearchDetail') }}</p>
        <label class="agent-m2-field">{{ text('include') }}
          <textarea v-model="includeText" rows="2" :aria-label="text('include')" :placeholder="text('includeHint')" :disabled="agent.busy || agent.conversation.projectAccess.busy" />
        </label>
        <label class="agent-m2-field">{{ text('exclude') }}
          <textarea v-model="excludeText" rows="2" :aria-label="text('exclude')" :placeholder="text('excludeHint')" :disabled="agent.busy || agent.conversation.projectAccess.busy" />
        </label>
        <div class="agent-m2-actions">
          <button type="button" :disabled="agent.busy || agent.conversation.projectAccess.busy" @click="agent.setProjectSearchEnabled(true)">
            {{ agent.conversation.projectAccess.grantId ? text('updateGrant') : text('grant') }}
          </button>
          <button v-if="agent.conversation.projectAccess.grantId" type="button" :disabled="agent.busy || agent.conversation.projectAccess.busy" @click="agent.setProjectSearchEnabled(false)">{{ text('revoke') }}</button>
        </div>
        <p>{{ text('dirtyBuffers') }}</p>
        <p v-if="agent.conversation.projectAccess.error" class="agent-m2-error" role="alert">{{ agent.conversation.projectAccess.error }}</p>
      </template>
      <p v-else>{{ text('noProject') }}</p>
    </details>

    <details class="agent-m2-section">
      <summary>{{ text('projectConfigTitle') }}</summary>
      <p v-if="agent.projectConfigLoading">{{ text('configLoading') }}</p>
      <template v-else-if="agent.projectConfigRoot">
        <label class="agent-m2-checkbox"><input v-model="agent.conversation.applyProjectWritingRules" type="checkbox" :disabled="agent.busy" />{{ text('writingRulesToggle') }}</label>
        <label class="agent-m2-field">{{ text('language') }}<input v-model="agent.projectConfig.writing!.language" maxlength="120" /></label>
        <label class="agent-m2-field">{{ text('audience') }}<input v-model="agent.projectConfig.writing!.audience" maxlength="500" /></label>
        <label class="agent-m2-field">{{ text('tone') }}<input v-model="agent.projectConfig.writing!.tone" maxlength="500" /></label>
        <label class="agent-m2-checkbox"><input v-model="agent.projectConfig.projectSearch!.enabledByDefault" type="checkbox" />{{ text('enabledByDefault') }}</label>
        <small>{{ text('enabledByDefaultHint') }}</small>
        <section class="agent-m2-glossary">
          <strong>{{ text('glossary') }}</strong>
          <div v-for="(term, index) in glossary" :key="index" class="agent-m2-term">
            <label class="agent-m2-field">{{ text('preferred') }}<input v-model="term.preferred" maxlength="200" /></label>
            <label class="agent-m2-field">{{ text('avoid') }}<textarea :value="term.avoid.join('\n')" rows="2" @input="updateAvoid(index, ($event.target as HTMLTextAreaElement).value)" /></label>
            <button type="button" @click="removeTerm(index)">{{ text('removeTerm') }}</button>
          </div>
          <button type="button" @click="addTerm">{{ text('addTerm') }}</button>
        </section>
        <button type="button" :disabled="agent.projectConfigSaving" @click="agent.saveProjectConfig()">{{ agent.projectConfigSaving ? text('configSaving') : text('configSave') }}</button>
        <span v-if="agent.projectConfigSaved" role="status">{{ text('configSaved') }}</span>
      </template>
      <p v-else>{{ text('configUnavailable') }}</p>
      <p v-if="agent.projectConfigError" class="agent-m2-error" role="alert">{{ agent.projectConfigError }} <button type="button" :disabled="agent.projectConfigLoading" @click="agent.loadProjectConfig()">{{ text('configReload') }}</button></p>
    </details>

    <details class="agent-m2-section">
      <summary>{{ text('checkTitle') }}</summary>
      <p>{{ text('checkScope') }}</p>
      <div class="agent-m2-actions">
        <button type="button" :disabled="agent.documentCheckBusy || !editor.currentFile" @click="agent.checkCurrentDocument()">{{ agent.documentCheckBusy ? text('checkRunning') : text('checkRun') }}</button>
        <button type="button" :disabled="agent.busy || !editor.currentFile" :title="text('modelCheckDetail')" @click="agent.requestModelCheck()">{{ text('modelCheck') }}</button>
      </div>
      <p v-if="agent.documentCheckError" class="agent-m2-error" role="alert">{{ agent.documentCheckError }}</p>
      <template v-if="agent.documentCheck">
        <p>{{ agent.documentCheck.result.complete ? text('checkComplete') : text('checkPartial') }} · {{ text('issueCount', { count: agent.documentCheck.result.issues.length }) }}</p>
        <p v-if="agent.documentCheck.result.externalLinksUnchecked">{{ text('checkedExternal', { count: agent.documentCheck.result.externalLinksUnchecked }) }}</p>
        <p v-if="agent.documentCheck.result.localTargetsChecked">{{ text('checkedLocal', { count: agent.documentCheck.result.localTargetsChecked }) }}</p>
        <p v-if="!agent.documentCheck.result.issues.length">{{ text('checkNoIssues') }}</p>
        <article v-for="issue in agent.documentCheck.result.issues" :key="issue.id" class="agent-m2-issue">
          <strong>{{ issue.message }}</strong>
          <small>{{ issue.severity }} · {{ text('candidateLine', { line: issue.line }) }}</small>
          <blockquote>{{ issue.evidence }}</blockquote>
          <small v-if="issue.replacement">{{ text('replacement') }}: {{ issue.replacement }}</small>
          <div class="agent-m2-actions">
            <button type="button" @click="agent.locateDocumentIssue(issue)">{{ text('locateIssue') }}</button>
            <button type="button" :disabled="agent.busy" @click="agent.requestDocumentRepair(issue)">{{ text('draftRepair') }}</button>
          </div>
        </article>
      </template>
    </details>

    <details class="agent-m2-section">
      <summary>{{ text('webTitle') }} · {{ agent.conversation.webResearch.enabled ? text('webEnable') : text('webOff') }}</summary>
      <label class="agent-m2-checkbox"><input :checked="agent.conversation.webResearch.enabled" type="checkbox" @change="setWebResearchEnabled" />{{ text('webEnable') }}</label>
      <small>{{ text('webPrivacyDisclosure') }}</small>
      <label class="agent-m2-checkbox"><input v-model="agent.conversation.webResearch.publicDns" type="checkbox" :disabled="!agent.conversation.webResearch.enabled" />{{ text('publicDns') }}</label>
      <small>{{ text('publicDnsDisclosure') }}</small>
      <label class="agent-m2-field">{{ text('webTopic') }}<input v-model="agent.conversation.webResearch.topic" maxlength="1000" :placeholder="text('webTopicPlaceholder')" /></label>
      <label class="agent-m2-checkbox"><input v-model="agent.conversation.webResearch.allowDocumentQueries" type="checkbox" />{{ text('allowDocumentQueries') }}</label>
      <button type="button" :disabled="!agent.conversation.webResearch.allowDocumentQueries || !editor.currentFile" @click="agent.suggestWebQueries()">{{ text('querySuggestion') }}</button>
      <section v-if="agent.conversation.webResearch.suggestedQueries.length" class="agent-m2-query-suggestions">
        <small>{{ text('querySuggestionReview') }}</small>
        <div v-for="(suggestion, index) in agent.conversation.webResearch.suggestedQueries" :key="index" class="agent-m2-query-suggestion">
          <input v-model="agent.conversation.webResearch.suggestedQueries[index]" maxlength="320" :aria-label="text('querySuggestion')" />
          <button type="button" @click="agent.approveWebQuery(suggestion)">{{ text('approveQuery') }}</button>
        </div>
      </section>
      <label class="agent-m2-field">{{ text('approvedQueries') }}<textarea v-model="approvedQueriesText" rows="3" :placeholder="text('queryPlaceholder')" /></label>
      <small>{{ text('approvedQueriesHint') }}</small>
      <label class="agent-m2-field">{{ text('directUrls') }}<textarea v-model="urlsText" rows="2" :placeholder="text('urlPlaceholder')" /></label>
      <small>{{ text('directUrlsHint') }}</small>
    </details>
  </div>
</template>
