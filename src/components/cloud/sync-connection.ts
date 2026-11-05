import { h } from 'vue'
import { ElMessageBox } from 'element-plus'
import { t } from '@/i18n'
import type { StorageConnection } from '@/services/cloud-storage'
import { useCloudStorageStore } from '@/stores/cloudStorage'

export async function syncWithGitReview(connection: StorageConnection): Promise<boolean | undefined> {
  const cloud = useCloudStorageStore()
  if (!await cloud.sync(connection)) return false
  const result = cloud.syncResults[connection.id]
  if (result?.state !== 'localChanges' || !result.changes?.length || !result.target) return true

  const { changes, target } = result
  const paths = [...new Set(changes.map(change => change.path))]
  try {
    await ElMessageBox.confirm(
      h('div', { style: { overflowWrap: 'anywhere' } }, [
        h('p', t('prefs.cloud.commitDetail', {
          repository: target.repositoryPath,
          remote: target.remote,
          branch: target.branch,
        })),
        h('ul', { style: { maxHeight: '35vh', overflow: 'auto' } },
          changes.map(({ path, code }) => h('li', { key: path }, [h('code', code), ` ${path}`])),
        ),
      ]),
      t('prefs.cloud.commitTitle'),
      {
        customStyle: { maxWidth: '560px' },
        confirmButtonText: t('prefs.cloud.commitSync'),
        cancelButtonText: t('common.cancel'),
        closeOnClickModal: false,
      },
    )
  } catch {
    return undefined
  }
  return cloud.sync(connection, paths, target)
}
