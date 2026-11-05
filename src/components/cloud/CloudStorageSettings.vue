<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { openFolder } from '@/services/tauri-invoke'
import type {
  GitSyncResult,
  StorageConnection,
  StorageConnectionInput,
  StorageProviderKind,
  StorageSyncResult,
} from '@/services/cloud-storage'
import { useCloudStorageStore } from '@/stores/cloudStorage'
import { useI18n } from '@/i18n'
import { syncWithGitReview } from './sync-connection'

const cloud = useCloudStorageStore()
const { t } = useI18n()
const editing = ref(false)
const secret = ref('')

const blank = (): StorageConnectionInput => ({
  name: '',
  kind: 'selfHosted',
  endpoint: '',
  username: '',
  workspaceId: '',
  localRoot: '',
  repositoryPath: '',
  remote: 'origin',
  branch: 'main',
  pluginId: '',
  pluginConfig: '{}',
})
const form = reactive<StorageConnectionInput>(blank())

const requiresEndpoint = computed(() => form.kind === 'selfHosted' || form.kind === 'webdav')
const requiresSecret = computed(() => form.kind === 'selfHosted' || form.kind === 'webdav' || form.kind === 'plugin')

function resetForm(): void {
  Object.assign(form, blank())
  secret.value = ''
  editing.value = false
  cloud.clearFeedback()
}

function startCreate(): void {
  resetForm()
  editing.value = true
}

function startEdit(connection: StorageConnection): void {
  Object.assign(form, {
    id: connection.id,
    name: connection.name,
    kind: connection.kind,
    endpoint: connection.endpoint ?? '',
    username: connection.username ?? '',
    workspaceId: connection.workspaceId ?? '',
    localRoot: connection.localRoot,
    repositoryPath: connection.repositoryPath ?? '',
    remote: connection.remote ?? 'origin',
    branch: connection.branch ?? 'main',
    pluginId: connection.pluginId ?? '',
    pluginConfig: connection.pluginConfig ?? '{}',
  })
  secret.value = ''
  editing.value = true
  cloud.clearFeedback()
}

async function chooseLocalRoot(): Promise<void> {
  const folder = await openFolder()
  if (folder) {
    form.localRoot = folder
    if (form.kind === 'git') form.repositoryPath = folder
  }
}

function valid(): boolean {
  if (!form.name.trim() || !form.localRoot.trim()) return false
  if (requiresEndpoint.value && !form.endpoint?.trim()) return false
  if (form.kind === 'selfHosted' && !form.workspaceId?.trim()) return false
  if (form.kind === 'git' && !form.repositoryPath?.trim()) return false
  if (form.kind === 'plugin' && !form.pluginId?.trim()) return false
  return true
}

async function save(): Promise<void> {
  if (!valid()) return
  if (await cloud.save({ ...form }, secret.value || undefined)) resetForm()
}

async function remove(connection: StorageConnection): Promise<void> {
  try {
    await ElMessageBox.confirm(
      t('prefs.cloud.deleteDetail', { name: connection.name }),
      t('prefs.cloud.deleteTitle'),
      { type: 'warning', confirmButtonText: t('common.delete'), cancelButtonText: t('common.cancel') },
    )
    await cloud.remove(connection.id)
  } catch { /* cancelled */ }
}

function resultText(connection: StorageConnection): string {
  const result = cloud.syncResults[connection.id]
  if (!result) return ''
  if ('uploaded' in result) {
    const sync = result as StorageSyncResult
    return t('prefs.cloud.syncSummary', {
      state: sync.state,
      uploaded: sync.uploaded,
      downloaded: sync.downloaded,
      conflicts: sync.conflicts.length,
    })
  }
  const git = result as GitSyncResult
  return t('prefs.cloud.gitSummary', {
    state: t(`prefs.cloud.gitState.${git.state}`),
    ahead: git.ahead,
    behind: git.behind,
    conflicts: git.conflicts.length,
  })
}

function gitResult(connection: StorageConnection): GitSyncResult | null {
  const result = cloud.syncResults[connection.id]
  return connection.kind === 'git' && result && 'ahead' in result ? result as GitSyncResult : null
}

function providerLabel(kind: StorageProviderKind): string {
  return t(`prefs.cloud.provider.${kind}`)
}

onMounted(() => { void cloud.load() })
</script>

<template>
  <div class="cloud-settings">
    <p class="cloud-intro">{{ t('prefs.cloud.intro') }}</p>
    <el-alert v-if="cloud.lastError" type="error" :closable="false" show-icon>
      {{ cloud.lastError }}
    </el-alert>

    <div v-if="!editing" class="connection-list" :aria-busy="cloud.loading">
      <article v-for="connection in cloud.connections" :key="connection.id" class="connection-card">
        <div class="connection-copy">
          <strong>{{ connection.name }}</strong>
          <span>{{ providerLabel(connection.kind) }}</span>
          <small>{{ connection.localRoot }}</small>
          <small v-if="resultText(connection)" role="status">{{ resultText(connection) }}</small>
        </div>
        <div class="connection-actions">
          <el-button
            size="small"
            :loading="cloud.busyId === connection.id"
            @click="syncWithGitReview(connection)"
          >
            {{ t('prefs.cloud.syncNow') }}
          </el-button>
          <el-button
            v-if="gitResult(connection)?.state === 'diverged'"
            size="small"
            type="warning"
            plain
            @click="cloud.prepareGitMerge(connection.id)"
          >
            {{ t('prefs.cloud.prepareMerge') }}
          </el-button>
          <el-button
            v-if="['conflicts', 'mergeReady'].includes(gitResult(connection)?.state ?? '')"
            size="small"
            @click="cloud.abortGit(connection.id)"
          >
            {{ t('prefs.cloud.abortMerge') }}
          </el-button>
          <el-button size="small" @click="startEdit(connection)">{{ t('common.edit') }}</el-button>
          <el-button size="small" type="danger" plain @click="remove(connection)">{{ t('common.delete') }}</el-button>
        </div>
      </article>
      <p v-if="!cloud.loading && !cloud.hasConnections" class="empty-copy">{{ t('prefs.cloud.empty') }}</p>
      <el-button type="primary" @click="startCreate">{{ t('prefs.cloud.add') }}</el-button>
    </div>

    <el-form v-else label-width="210px" label-position="left" class="connection-form">
      <el-form-item :label="t('prefs.cloud.name')" required>
        <el-input v-model="form.name" maxlength="80" />
      </el-form-item>
      <el-form-item :label="t('prefs.cloud.type')" required>
        <el-select v-model="form.kind" :disabled="Boolean(form.id)">
          <el-option :label="providerLabel('selfHosted')" value="selfHosted" />
          <el-option :label="providerLabel('git')" value="git" />
          <el-option :label="providerLabel('webdav')" value="webdav" />
          <el-option :label="providerLabel('plugin')" value="plugin" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="requiresEndpoint" :label="t('prefs.cloud.endpoint')" required>
        <el-input v-model="form.endpoint" placeholder="https://" />
      </el-form-item>
      <el-form-item v-if="form.kind === 'webdav'" :label="t('prefs.cloud.username')">
        <el-input v-model="form.username" autocomplete="username" />
      </el-form-item>
      <el-form-item v-if="form.kind === 'selfHosted'" :label="t('prefs.cloud.workspaceId')" required>
        <el-input v-model="form.workspaceId" />
      </el-form-item>
      <el-form-item v-if="requiresSecret" :label="t('prefs.cloud.secret')">
        <el-input
          v-model="secret"
          type="password"
          show-password
          autocomplete="new-password"
          :placeholder="form.id ? t('prefs.cloud.secretKeep') : ''"
        />
      </el-form-item>
      <el-form-item v-if="form.kind === 'plugin'" :label="t('prefs.cloud.plugin')" required>
        <el-select v-model="form.pluginId">
          <el-option v-for="plugin in cloud.plugins" :key="plugin.id" :label="plugin.name" :value="plugin.id" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="form.kind === 'plugin'" :label="t('prefs.cloud.pluginConfig')">
        <el-input v-model="form.pluginConfig" type="textarea" :rows="4" />
      </el-form-item>
      <el-form-item :label="t('prefs.cloud.localRoot')" required>
        <div class="input-with-action">
          <el-input v-model="form.localRoot" />
          <el-button @click="chooseLocalRoot">{{ t('common.browse') }}</el-button>
        </div>
      </el-form-item>
      <template v-if="form.kind === 'git'">
        <el-form-item :label="t('prefs.cloud.repository')" required>
          <el-input v-model="form.repositoryPath" />
        </el-form-item>
        <el-form-item :label="t('prefs.cloud.remote')">
          <el-input v-model="form.remote" />
        </el-form-item>
        <el-form-item :label="t('prefs.cloud.branch')">
          <el-input v-model="form.branch" />
        </el-form-item>
        <p class="agent-note">{{ t('prefs.cloud.agentConflict') }}</p>
      </template>
      <el-alert v-if="cloud.lastProbe" :type="cloud.lastProbe.ok ? 'success' : 'warning'" :closable="false">
        {{ cloud.lastProbe.message }}
      </el-alert>
      <div class="form-actions">
        <el-button :disabled="!valid()" @click="cloud.probe({ ...form }, secret || undefined)">{{ t('prefs.cloud.test') }}</el-button>
        <el-button type="primary" :disabled="!valid()" @click="save">{{ t('common.save') }}</el-button>
        <el-button @click="resetForm">{{ t('common.cancel') }}</el-button>
      </div>
    </el-form>
  </div>
</template>

<style scoped>
.cloud-settings { display: grid; gap: 18px; min-width: 0; }
.cloud-intro, .empty-copy, .agent-note { margin: 0; color: var(--mt-fg-muted); line-height: 1.7; font-size: 12px; }
.connection-list { display: grid; gap: 14px; }
.connection-card { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; border: 1px solid var(--mt-border); border-radius: 10px; padding: 19px; background: var(--mt-surface-raised); }
.connection-copy { min-width: 0; display: grid; gap: 6px; }
.connection-copy strong { font-size: 14px; font-weight: 600; color: var(--mt-fg); }
.connection-copy span { font-size: 11px; color: var(--mt-accent); }
.connection-copy small { color: var(--mt-fg-muted); overflow-wrap: anywhere; font-size: 11px; line-height: 1.6; }
.connection-actions { justify-content: flex-end; }
.connection-actions, .form-actions { display: flex; flex-wrap: wrap; gap: 7px; }
.connection-actions :deep(.el-button + .el-button), .form-actions :deep(.el-button + .el-button) { margin-left: 0; }
.connection-list > .el-button { justify-self: start; margin-top: 4px; }
.empty-copy { border: 1px dashed var(--mt-border); border-radius: 10px; background: var(--mt-surface); padding: 32px 22px; text-align: center; }
.input-with-action { display: flex; width: 100%; min-width: 0; gap: 8px; }
.input-with-action :deep(.el-input) { min-width: 0; }
.connection-form :deep(.el-select) { width: 100%; }
.form-actions { justify-content: flex-end; padding-top: 20px; border-top: 1px solid var(--mt-border); margin-top: 16px; }
.agent-note { margin: 4px 0 16px 210px; padding: 12px 14px; background: var(--mt-accent-soft); border-radius: 7px; }
@media (max-width: 1000px) { .connection-card { flex-direction: column; } .connection-actions { justify-content: flex-start; } }
@media (max-width: 760px) { .connection-card { align-items: stretch; padding: 16px; } .agent-note { margin-left: 0; } }
@media (max-width: 620px) { .connection-form :deep(.el-form-item) { display: block; } .connection-form :deep(.el-form-item__label) { width: 100% !important; height: auto; line-height: 1.5; margin-bottom: 7px; } .connection-form :deep(.el-form-item__content) { margin-left: 0 !important; min-width: 0; } }
</style>
