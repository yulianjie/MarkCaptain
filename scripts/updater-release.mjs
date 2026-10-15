import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash, createPublicKey, verify } from 'node:crypto'

/** Verify both Minisign signatures against the public key shipped to users. */
export function verifyUpdaterSignature(bytes, encodedSignature, encodedPublicKey) {
  const publicLines = Buffer.from(encodedPublicKey.trim(), 'base64').toString('utf8').trim().split(/\r?\n/)
  const lines = Buffer.from(encodedSignature.trim(), 'base64').toString('utf8').trim().split(/\r?\n/)
  const publicBytes = Buffer.from(publicLines[1] ?? '', 'base64')
  const signature = Buffer.from(lines[1] ?? '', 'base64')
  const globalSignature = Buffer.from(lines[3] ?? '', 'base64')
  if (publicBytes.length !== 42 || signature.length !== 74 || globalSignature.length !== 64
    || !lines[2]?.startsWith('trusted comment: ')
    || !publicBytes.subarray(2, 10).equals(signature.subarray(2, 10))) {
    throw new Error('Invalid updater signature or signing key mismatch')
  }
  const algorithm = signature.subarray(0, 2).toString('ascii')
  if (algorithm !== 'ED' && algorithm !== 'Ed') throw new Error('Unsupported signature algorithm')
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicBytes.subarray(10)]),
    format: 'der', type: 'spki',
  })
  const payload = algorithm === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes
  if (!verify(null, payload, key, signature.subarray(10))
    || !verify(null, Buffer.concat([signature.subarray(10), Buffer.from(lines[2].slice(17))]), key, globalSignature)) {
    throw new Error('Updater signature verification failed')
  }
}

export const platforms = {
  'darwin-aarch64': ['macos', '.app.tar.gz'],
  'darwin-x86_64': ['macos', '.app.tar.gz'],
  'linux-x86_64': ['appimage', '.AppImage'],
  'windows-x86_64': ['nsis', '.exe'],
}

export function updaterAssetName(tag, platform) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('Updater releases require a stable vX.Y.Z tag')
  if (!platforms[platform]) throw new Error(`Unsupported updater platform: ${platform}`)
  return `MarkCaptain_${tag}_${platform}${platforms[platform][1]}`
}

export function stageUpdater(bundleDir, output, tag, platform) {
  const name = updaterAssetName(tag, platform)
  const [folder, extension] = platforms[platform]
  const directory = join(bundleDir, folder)
  const candidates = readdirSync(directory).filter(file => file.endsWith(extension))
  if (candidates.length !== 1) throw new Error(`Expected one signed ${platform} artifact, found ${candidates.length}`)
  const source = join(directory, candidates[0])
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
  if (config.version !== tag.slice(1)) throw new Error('Release tag and bundled application version do not match')
  verifyUpdaterSignature(readFileSync(source), readFileSync(`${source}.sig`, 'utf8'), config.plugins.updater.pubkey)
  mkdirSync(output, { recursive: true })
  copyFileSync(source, join(output, name))
  copyFileSync(`${source}.sig`, join(output, `${name}.sig`))
}

export function createManifest(tag, assets, readSignature, notes, date) {
  const targets = {}
  for (const platform of Object.keys(platforms)) {
    const name = updaterAssetName(tag, platform)
    const artifact = assets.find(asset => asset.name === name)
    const signatureAsset = assets.find(asset => asset.name === `${name}.sig`)
    if (!artifact?.size || !signatureAsset?.size) throw new Error(`Missing signed release artifact for ${platform}`)
    const url = new URL(artifact.url)
    if (url.origin !== 'https://github.com'
      || !url.pathname.startsWith(`/yulianjie/MarkCaptain/releases/download/${tag}/`)) {
      throw new Error(`Unexpected update URL: ${artifact.url}`)
    }
    const signature = readSignature(`${name}.sig`).trim()
    if (!signature) throw new Error(`Empty signature for ${platform}`)
    targets[platform] = { url: artifact.url, signature }
  }
  return { version: tag.slice(1), notes, pub_date: date, platforms: targets }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [mode, ...args] = process.argv.slice(2)
  if (mode === 'stage') {
    stageUpdater(...args)
  } else if (mode === 'manifest') {
    const [tag, output] = args
    updaterAssetName(tag, 'windows-x86_64')
    const repo = 'yulianjie/MarkCaptain'
    const release = JSON.parse(execFileSync('gh', ['release', 'view', tag, '--repo', repo,
      '--json', 'assets,isDraft,isPrerelease,publishedAt'], { encoding: 'utf8' }))
    if (release.isDraft || release.isPrerelease) throw new Error('Updater manifest requires a published stable release')
    mkdirSync(output, { recursive: true })
    execFileSync('gh', ['release', 'download', tag, '--repo', repo, '--pattern', '*.sig', '--dir', output, '--clobber'])
    const manifest = createManifest(tag, release.assets,
      name => readFileSync(join(output, name), 'utf8'),
      readFileSync(`docs/releases/${tag}.md`, 'utf8'), release.publishedAt)
    writeFileSync(join(output, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n')
  } else {
    throw new Error('Usage: updater-release.mjs stage <bundleDir> <output> <tag> <platform> | manifest <tag> <output>')
  }
}
