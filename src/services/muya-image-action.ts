/**
 * Muya image-action callback.
 *
 * Muya invokes `options.imageAction(file, id, name?)` whenever it has an
 * image to materialise (drag/paste/file-picker). `file` is a `File` for
 * pasted/dropped browser blobs, or a string `path` for filesystem paths.
 * The return value is the final `src` Muya writes into the markdown.
 *
 * We branch on `prefs.imageInsertAction`:
 *   - 'path':   keep the absolute path / data URL — Muya already has it
 *   - 'folder': copy into `imageFolderPath` (or a relative `imageRelativeDirectoryName`
 *               folder next to the open file) via `cmd_save_image_local`
 *   - 'upload': base64-encode and PUT to GitHub via `cmd_upload_image_github`
 *               (requires `currentUploader === 'github'` with token + owner + repo).
 *
 * If a step fails, fall back to the raw path/data URL so the editor isn't
 * left with a broken image — surface the error through the notification store.
 */
import { saveImageLocal, uploadImageGithub, uploadImagePicgo, uploadImageScript } from './tauri-invoke'
import { tempDir } from '@tauri-apps/api/path'
import { usePreferencesStore } from '@/stores/preferences'
import { useEditorStore } from '@/stores/editor'
import { useNotificationStore } from '@/stores/notification'
import { toPortableRelativeImageSrc } from './portable-image-path'

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i) : ''
}

function uniqFilename(base: string, ext: string): string {
  const stamp = Date.now()
  const rand = Math.floor(Math.random() * 1e4).toString(36)
  const safeBase = base.replace(/[^\w.-]/g, '_').slice(0, 40) || 'image'
  return `${safeBase}-${stamp}-${rand}${ext || '.png'}`
}

async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

async function fileToBase64(file: File): Promise<string> {
  const data = await fileToDataUrl(file)
  const comma = data.indexOf(',')
  return comma >= 0 ? data.slice(comma + 1) : data
}

function parentDirOf(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return idx >= 0 ? path.slice(0, idx) : path
}

function basenameNoExt(path: string): string {
  const base = path.split(/[\\/]/).pop() || path
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/**
 * Expand `${...}` template variables in a relative-image-directory path.
 * Mirrors the upstream subset:
 *   - `${filename}`                  — current doc basename without ext
 *   - `${fileBasenameNoExtension}`   — alias of `${filename}`
 *   - `${fileDirname}`               — parent dir of the current doc
 *   - `${fileWorkspaceFolder}`       — currently falls back to `${fileDirname}`;
 *                                       this service has no validated workspace
 *                                       root to expand here
 *   - `${relativeFileDirname}`       — basename of `${fileDirname}`
 *
 * Unknown variables are left untouched so the user sees the mistake.
 */
function expandImageDirTemplate(tmpl: string, docPath: string): string {
  if (!tmpl || !docPath) return tmpl
  const dir = parentDirOf(docPath)
  const name = basenameNoExt(docPath)
  const relDirname = dir.split(/[\\/]/).pop() || dir
  return tmpl
    .replace(/\$\{filename\}/g, name)
    .replace(/\$\{fileBasenameNoExtension\}/g, name)
    .replace(/\$\{fileDirname\}/g, dir)
    .replace(/\$\{fileWorkspaceFolder\}/g, dir)
    .replace(/\$\{relativeFileDirname\}/g, relDirname)
}

export async function muyaImageAction(input: File | string, _id: string, _name?: string): Promise<string> {
  const prefs = usePreferencesStore()
  const editor = useEditorStore()
  const notify = useNotificationStore()

  const action = prefs.imageInsertAction

  // Determine source kind + a reasonable filename.
  const isFile = typeof input !== 'string'
  const origName = isFile ? input.name : (input.split(/[\\/]/).pop() || 'image')
  const filename = uniqFilename(origName.replace(/\.[^.]+$/, ''), extOf(origName))

  // Path mode → just hand back what Muya gave us (data URL or absolute path).
  if (action === 'path') {
    if (isFile) return await fileToDataUrl(input)
    return input
  }

  // Folder mode → copy to imageFolderPath or relative folder next to the doc.
  if (action === 'folder') {
    try {
      const tab = editor.currentFile
      const documentPath = tab?.pathname || ''
      const useRelativeDirectory = prefs.imagePreferRelativeDirectory && Boolean(documentPath)
      let targetDir = prefs.imageFolderPath
      if (useRelativeDirectory) {
        const rel = expandImageDirTemplate(
          prefs.imageRelativeDirectoryName || 'assets',
          documentPath,
        )
        targetDir = `${parentDirOf(documentPath)}/${rel}`
      }
      if (!targetDir) {
        notify.pushToast({
          type: 'warning',
          message: 'No image folder configured; using path mode for this image.',
        })
        return isFile ? await fileToDataUrl(input) : input
      }
      const { path } = await saveImageLocal({
        sourcePath: isFile ? undefined : input,
        dataUrl: isFile ? await fileToDataUrl(input) : undefined,
        targetDir,
        filename,
      })
      if (useRelativeDirectory) {
        const relativeSrc = toPortableRelativeImageSrc(documentPath, path)
        if (relativeSrc !== null) return relativeSrc
        notify.pushToast({
          type: 'warning',
          title: 'Portable image link unavailable',
          message: 'The image was saved, but its path cannot be made relative to this document. Using the absolute path instead.',
        })
      }
      return path
    } catch (err) {
      notify.pushToast({
        type: 'error',
        title: 'Image save failed',
        message: err instanceof Error ? err.message : String(err),
      })
      return isFile ? await fileToDataUrl(input) : input
    }
  }

  // Upload mode → GitHub / PicGo / custom script depending on which
  // backend the user picked in preferences.
  if (action === 'upload') {
    try {
      const uploader = prefs.currentUploader
      if (uploader === 'github') {
        if (!prefs.githubToken) throw new Error('GitHub token is not set')
        const base64 = isFile ? await fileToBase64(input) : await readPathAsBase64(input)
        const { downloadUrl } = await uploadImageGithub({
          token: prefs.githubToken,
          owner: prefs.imageBed.github.owner,
          repo: prefs.imageBed.github.repo,
          branch: prefs.imageBed.github.branch || undefined,
          path: `markcaptain/${filename}`,
          contentBase64: base64,
        })
        return downloadUrl
      }
      if (uploader === 'picgo' || uploader === 'script') {
        // PicGo and CLI scripts both expect a local file path. For File
        // blobs we materialise to the OS tempdir first.
        const sourcePath = isFile
          ? await materialiseToTempFile(input, filename)
          : input
        if (uploader === 'picgo') {
          const { urls } = await uploadImagePicgo({
            binary: prefs.picgoPath || undefined,
            sourcePaths: [sourcePath],
          })
          if (urls.length === 0) throw new Error('PicGo returned no URLs')
          return urls[0]
        }
        if (!prefs.cliScript) throw new Error('Custom upload script is not configured')
        const { urls } = await uploadImageScript({
          script: prefs.cliScript,
          sourcePaths: [sourcePath],
        })
        if (urls.length === 0) throw new Error('Upload script returned no URLs')
        return urls[0]
      }
      notify.pushToast({
        type: 'warning',
        message: 'Image upload is not configured; falling back to local path.',
      })
      return isFile ? await fileToDataUrl(input) : input
    } catch (err) {
      notify.pushToast({
        type: 'error',
        title: 'Image upload failed',
        message: err instanceof Error ? err.message : String(err),
      })
      return isFile ? await fileToDataUrl(input) : input
    }
  }

  return isFile ? await fileToDataUrl(input) : input
}

/**
 * Write a `File` blob into the OS tempdir under its mangled filename. Used
 * by PicGo / CLI uploaders since they speak in filesystem paths.
 */
async function materialiseToTempFile(file: File, filename: string): Promise<string> {
  const tmp = await tempDir()
  const targetDir = tmp.replace(/[\\/]$/, '')
  const dataUrl = await fileToDataUrl(file)
  const { path } = await saveImageLocal({
    dataUrl,
    targetDir,
    filename,
  })
  return path
}

async function readPathAsBase64(path: string): Promise<string> {
  // tauri-plugin-fs exposes readFile from anywhere in the FS scope.
  const { readFile } = await import('@tauri-apps/plugin-fs')
  const bytes = await readFile(path)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}
