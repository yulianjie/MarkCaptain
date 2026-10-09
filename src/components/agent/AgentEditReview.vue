<script setup lang="ts">
import { computed } from 'vue'
import { RotateCcw } from '@lucide/vue'
import { useI18n } from '@/i18n'
import { useAgentStore } from '@/stores/agent'
import { changeDiff, type ReviewedEdit } from '@/services/agent'

const props = defineProps<{ edit: ReviewedEdit }>()
const agent = useAgentStore()
const { t } = useI18n()
const diffs = computed(() => props.edit.changes.map(changeDiff))
const pending = computed(() => props.edit.changes.some(change => change.status === 'pending'))
const applied = computed(() => props.edit.changes.some(change => change.status === 'applied'))
const readOnly = computed(() => !!props.edit.locked || !!props.edit.rebasedTo)
const stale = computed(() => !!props.edit.documentChanged)
</script>

<template>
  <section class="agent-edit">
    <strong>{{ edit.title }}</strong>
    <p v-if="edit.documentChanged" class="agent-muted" role="status">{{ t('agent.reviewDocumentChanged') }}</p>
    <p v-if="edit.rebasedFrom" class="agent-muted" role="status">{{ t('agent.reviewRebased') }}</p>
    <p v-if="edit.rebasedTo" class="agent-muted" role="status">{{ t('agent.reviewSuperseded') }}</p>
    <p v-if="edit.rebaseConflicts?.length" class="agent-muted" role="alert">{{ t('agent.rebaseConflict', { count: edit.rebaseConflicts.length }) }}</p>
    <footer v-if="(edit.documentChanged || edit.rebaseConflicts?.length) && !readOnly" class="agent-edit-all">
      <button v-if="pending && stale" type="button" :disabled="agent.busy || !agent.includeDocument" @click="agent.rebaseReview(edit)">{{ t('agent.rebaseReview') }}</button>
      <button type="button" :disabled="!agent.canRegenerateReview(edit)" @click="agent.regenerateReview(edit)">{{ t('agent.regenerateReview') }}</button>
    </footer>
    <p v-if="edit.locked" class="agent-muted">{{ t('agent.history.locked') }}</p>
    <div v-for="(change, index) in edit.changes" :key="change.id" class="agent-edit-change agent-change" :data-change-id="change.id">
      <details open>
        <summary>{{ t('agent.viewChanges') }} · {{ t('agent.changeLines', { start: change.startLine, end: change.endLine }) }}</summary>
        <pre class="agent-line-diff"><code><span v-for="(line, lineIndex) in diffs[index]" :key="lineIndex" class="agent-diff-line" :class="`agent-line-${line.kind}`"><span class="agent-diff-sign" aria-hidden="true">{{ line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' ' }}</span><span class="agent-visually-hidden">{{ line.kind === 'added' ? t('agent.after') : line.kind === 'removed' ? t('agent.before') : '' }} </span>{{ line.text || '\u00a0' }}</span></code></pre>
      </details>
      <label class="agent-review-reason" :for="`agent-reason-${change.id}`">{{ t('agent.reviewReason') }}
        <textarea :id="`agent-reason-${change.id}`" :value="change.reason ?? ''" :disabled="agent.busy || readOnly" rows="2" maxlength="1000" :placeholder="t('agent.reviewReasonPlaceholder')" @input="agent.setReviewReason(edit, index, ($event.target as HTMLTextAreaElement).value)" />
      </label>
      <footer>
        <span>{{ t(edit.documentChanged && change.status === 'applied' ? 'agent.reviewUnverified' : `agent.editStatus.${change.status}`) }}</span>
        <button v-if="change.status === 'pending' || change.status === 'dismissed'" type="button" :disabled="stale || readOnly || edit.appliedMarkdown !== undefined && edit.appliedMarkdown !== edit.snapshot.markdown" @click="agent.locateSource({ ...edit.snapshot, from: change.from, to: change.to })">{{ t('agent.locateSource') }}</button>
        <template v-if="change.status === 'pending'">
          <button type="button" :disabled="agent.busy || readOnly" @click="agent.dismiss(edit, index)">{{ t(edit.changes.length > 1 ? 'agent.dismissChange' : 'agent.dismiss') }}</button>
          <button type="button" class="agent-primary" :disabled="agent.busy || readOnly || stale" @click="agent.apply(edit, index)">{{ t(edit.changes.length > 1 ? 'agent.applyChange' : 'agent.apply') }}</button>
        </template>
        <button v-if="change.status === 'applied'" type="button" :disabled="agent.busy || readOnly || stale" @click="agent.revert(edit, index)"><RotateCcw :size="12" />{{ t('agent.revert') }}</button>
        <button v-else type="button" :disabled="agent.busy || readOnly || stale || !!agent.conversation.draft.trim() || !!agent.conversation.images.length" @click="agent.rewrite(edit, index)">{{ t('agent.rewrite') }}</button>
      </footer>
    </div>
    <footer v-if="edit.changes.length > 1" class="agent-edit-all">
      <span>{{ t(edit.documentChanged && applied ? 'agent.reviewUnverified' : `agent.editStatus.${edit.status}`) }}</span>
      <template v-if="pending">
        <button type="button" :disabled="agent.busy || readOnly" @click="agent.dismiss(edit)">{{ t('agent.dismissAll') }}</button>
        <button type="button" class="agent-primary" :disabled="agent.busy || readOnly || stale" @click="agent.apply(edit)">{{ t('agent.applyAll') }}</button>
      </template>
      <button v-if="applied" type="button" :disabled="agent.busy || readOnly || stale" @click="agent.revert(edit)">{{ t('agent.revertAll') }}</button>
    </footer>
  </section>
</template>
