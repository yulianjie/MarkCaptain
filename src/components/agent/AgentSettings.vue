<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ArrowLeft, Check, LoaderCircle } from '@lucide/vue'
import { useAgentStore, agentError } from '@/stores/agent'
import { agentTransport } from '@/services/agent-transport'
import { AGENT_PRESETS, parseAgentHeaders, type AgentAuthMode } from '@/services/agent'
import { useI18n } from '@/i18n'

const agent = useAgentStore()
const { t } = useI18n()
const baseUrl = ref('')
const model = ref('')
const apiKey = ref('')
const headers = ref('')
const authMode = ref<AgentAuthMode>('system')
const preset = ref('deepseek')
const saving = ref(false)
const testing = ref(false)
const status = ref('')
const failure = ref('')
const sameEndpoint = computed(() => baseUrl.value.trim().replace(/\/$/, '') === agent.config?.baseUrl)
watch(() => agent.config, config => {
  if (!config) return
  baseUrl.value = config.baseUrl
  model.value = config.model
  authMode.value = config.authMode ?? 'system'
  preset.value = AGENT_PRESETS.find(p => p.baseUrl === config.baseUrl)?.id ?? 'custom'
}, { immediate: true })
watch([baseUrl, model, apiKey, headers, authMode], () => { status.value = ''; failure.value = '' })
watch(authMode, () => { apiKey.value = ''; headers.value = '' })

function choosePreset() {
  const selected = AGENT_PRESETS.find(p => p.id === preset.value)!
  baseUrl.value = selected.baseUrl
  model.value = selected.model
  authMode.value = selected.authMode
  apiKey.value = ''
  headers.value = ''
}
async function save(test = false) {
  if (saving.value || testing.value) return
  saving.value = true
  failure.value = ''; status.value = ''
  try {
    await agent.saveConfig({ baseUrl: baseUrl.value, model: model.value, authMode: authMode.value }, authMode.value === 'system' ? apiKey.value || undefined : undefined, authMode.value === 'system' ? parseAgentHeaders(headers.value) : undefined)
    apiKey.value = ''
    headers.value = ''
    status.value = t('agent.settings.saved')
    if (test) {
      testing.value = true
      await agentTransport.testConnection()
      status.value = t('agent.settings.connected')
    }
  } catch (error) { failure.value = agentError(error) }
  finally { saving.value = false; testing.value = false }
}
async function forget() {
  if (!agent.config || saving.value || testing.value) return
  saving.value = true
  failure.value = ''; status.value = ''
  try {
    await agent.saveConfig({ baseUrl: agent.config.baseUrl, model: agent.config.model, authMode: agent.config.authMode ?? 'system' }, '')
    apiKey.value = ''
    status.value = t('agent.settings.forgotten')
  } catch (error) { failure.value = agentError(error) }
  finally { saving.value = false }
}
async function forgetHeaders() {
  if (!agent.config || saving.value || testing.value) return
  saving.value = true
  failure.value = ''; status.value = ''
  try {
    await agent.saveConfig({ baseUrl: agent.config.baseUrl, model: agent.config.model, authMode: agent.config.authMode ?? 'system' }, undefined, [])
    headers.value = ''
    status.value = t('agent.settings.headersForgotten')
  } catch (error) { failure.value = agentError(error) }
  finally { saving.value = false }
}
onBeforeUnmount(() => { apiKey.value = ''; headers.value = '' })
</script>

<template>
  <section class="agent-settings">
    <button class="agent-back" type="button" @click="agent.settingsOpen = false"><ArrowLeft :size="16" />{{ t('agent.settings.back') }}</button>
    <h2>{{ t('agent.settings.title') }}</h2>
    <p>{{ t('agent.settings.description') }}</p>
    <form @submit.prevent="save(false)">
      <fieldset :disabled="saving || testing || agent.busy">
        <label for="agent-provider">{{ t('agent.settings.provider') }}</label>
        <select id="agent-provider" v-model="preset" @change="choosePreset">
          <option v-for="option in AGENT_PRESETS" :key="option.id" :value="option.id">{{ option.id === 'custom' ? t('agent.settings.custom') : option.name }}</option>
        </select>
        <label for="agent-url">{{ t('agent.settings.baseUrl') }}</label>
        <input id="agent-url" v-model="baseUrl" type="url" required placeholder="https://api.deepseek.com" autocomplete="off" spellcheck="false">
        <small>{{ t('agent.settings.urlHelp') }}</small>
        <label for="agent-model">{{ t('agent.settings.model') }}</label>
        <input id="agent-model" v-model="model" required maxlength="200" :placeholder="t('agent.settings.modelPlaceholder')" autocomplete="off" spellcheck="false">
        <label for="agent-auth-mode">{{ t('agent.settings.authMode') }}</label>
        <select id="agent-auth-mode" v-model="authMode">
          <option value="system">{{ t('agent.settings.authSystem') }}</option>
          <option value="none">{{ t('agent.settings.authNone') }}</option>
        </select>
        <small v-if="authMode === 'none'">{{ t('agent.settings.authNoneHelp') }}</small>
        <template v-if="authMode === 'system'">
        <label for="agent-key">API Key <span v-if="sameEndpoint && agent.config?.hasKey" class="agent-key-state"><Check :size="12" />{{ t('agent.settings.keySaved') }}</span></label>
        <input id="agent-key" v-model="apiKey" type="password" maxlength="4096" :placeholder="t(sameEndpoint && agent.config?.hasKey ? 'agent.settings.keepKey' : 'agent.settings.keyPlaceholder')" autocomplete="new-password" spellcheck="false">
        <small>{{ t('agent.settings.keyHelp') }}</small>
        <button v-if="sameEndpoint && agent.config?.hasKey" class="agent-text-button" type="button" @click="forget">{{ t('agent.settings.forgetKey') }}</button>
        <label for="agent-headers">{{ t('agent.settings.headers') }} <span v-if="sameEndpoint && agent.config?.hasHeaders" class="agent-key-state"><Check :size="12" />{{ t('agent.settings.headersSaved') }}</span></label>
        <textarea id="agent-headers" v-model="headers" rows="4" maxlength="32768" :placeholder="t(sameEndpoint && agent.config?.hasHeaders ? 'agent.settings.keepHeaders' : 'agent.settings.headersPlaceholder')" autocomplete="off" spellcheck="false" />
        <small>{{ t('agent.settings.headersHelp') }}</small>
        <button v-if="sameEndpoint && agent.config?.hasHeaders" class="agent-text-button" type="button" @click="forgetHeaders">{{ t('agent.settings.forgetHeaders') }}</button>
        </template>
        <div class="agent-settings-actions"><button type="submit" class="agent-primary">{{ t('common.save') }}</button><button type="button" @click="save(true)">{{ t('agent.settings.test') }}</button></div>
      </fieldset>
    </form>
    <p v-if="saving || testing" class="agent-settings-feedback" role="status"><LoaderCircle :size="14" class="agent-spin" />{{ t(testing ? 'agent.settings.testing' : 'agent.settings.saving') }}</p>
    <p v-else-if="status" class="agent-settings-feedback" role="status"><Check :size="14" />{{ status }}</p>
    <p v-if="failure" class="agent-error" role="alert">{{ failure }}</p>
    <p class="agent-settings-privacy">{{ t('agent.settings.privacy') }}</p>
  </section>
</template>
