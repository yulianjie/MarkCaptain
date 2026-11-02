<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowLeft } from '@lucide/vue'
import { useAgentStore } from '@/stores/agent'
import { useI18n } from '@/i18n'
const agent = useAgentStore()
const { t } = useI18n()
const query = ref('')
const items = computed(() => agent.historyItems.filter(item => item.title.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())))
</script>

<template>
  <section class="agent-history">
    <button class="agent-back" type="button" @click="agent.historyOpen = false"><ArrowLeft :size="16" />{{ t('agent.settings.back') }}</button>
    <h3>{{ t('agent.history.title') }}</h3>
    <label><input type="checkbox" :checked="agent.historyEnabled" :disabled="agent.historyLoading" @change="agent.setHistoryEnabled(($event.target as HTMLInputElement).checked)">{{ t('agent.history.enable') }}</label>
    <p class="agent-muted">{{ t('agent.history.detail') }}</p>
    <input v-model="query" type="search" :placeholder="t('agent.history.search')" :aria-label="t('agent.history.search')">
    <p v-if="agent.historyError" class="agent-error" role="alert">{{ agent.historyError }}</p>
    <p v-if="!items.length" class="agent-muted">{{ t('agent.history.empty') }}</p>
    <article v-for="item in items" :key="item.id" class="agent-history-item">
      <strong>{{ item.title }}</strong><time>{{ new Date(item.updatedAt).toLocaleString() }}</time>
      <div><button type="button" :disabled="agent.busy || agent.historyLoading" @click="agent.restoreHistory(item.id)">{{ t('agent.history.restore') }}</button><button type="button" :disabled="agent.historyLoading" @click="agent.exportConversation(item)">{{ t('agent.history.export') }}</button><button type="button" :disabled="agent.historyLoading" @click="agent.deleteHistory(item)">{{ t('agent.history.delete') }}</button></div>
    </article>
  </section>
</template>
