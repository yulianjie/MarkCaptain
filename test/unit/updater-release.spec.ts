import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
// @ts-expect-error The release CLI is a plain Node module.
import { createManifest, platforms, updaterAssetName, verifyUpdaterSignature } from '../../scripts/updater-release.mjs'

function signedFixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const keyId = randomBytes(8)
  const key = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  const publicText = `untrusted comment: test key\n${Buffer.concat([Buffer.from('Ed'), keyId, key]).toString('base64')}\n`
  const bytes = Buffer.from('signed update')
  const signature = sign(null, createHash('blake2b512').update(bytes).digest(), privateKey)
  const comment = 'timestamp:123 file:test'
  const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey)
  const text = `untrusted comment: test\n${Buffer.concat([Buffer.from('ED'), keyId, signature]).toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`
  return { bytes, key: Buffer.from(publicText).toString('base64'), signature: Buffer.from(text).toString('base64') }
}

describe('signed release manifest', () => {
  const tag = 'v1.2.3'
  function assets() {
    return Object.keys(platforms).flatMap(platform => {
      const name = updaterAssetName(tag, platform)
      return [name, `${name}.sig`].map(name => ({ name, size: 100, url: `https://github.com/yulianjie/MarkCaptain/releases/download/${tag}/${name}` }))
    })
  }

  it('requires all four platforms and embeds signature contents and release notes', () => {
    const manifest = createManifest(tag, assets(), () => 'signature\n', 'notes', '2026-10-15T00:00:00Z')
    expect(manifest).toMatchObject({ version: '1.2.3', notes: 'notes', pub_date: '2026-10-15T00:00:00Z' })
    expect(Object.keys(manifest.platforms)).toHaveLength(4)
    expect(manifest.platforms['windows-x86_64'].signature).toBe('signature')
    expect(() => createManifest(tag, assets().slice(1), () => 'signature', '', '')).toThrow('Missing signed')
    expect(() => createManifest(tag, assets(), () => '', '', '')).toThrow('Empty signature')
  })

  it('rejects foreign URLs and assets belonging to a different release', () => {
    for (const url of ['http://github.com/bad', 'https://evil.test/file.exe', 'https://github.com/yulianjie/MarkCaptain/releases/download/v1.2.2/file.exe']) {
      const list = assets()
      list[0].url = url
      expect(() => createManifest(tag, list, () => 'signature', '', '')).toThrow('Unexpected update URL')
    }
    expect(() => updaterAssetName('v1.2.3-beta', 'windows-x86_64')).toThrow('stable')
  })

  it('verifies artifact and trusted-comment signatures; rejects tampering and different keys', () => {
    const fixture = signedFixture()
    expect(() => verifyUpdaterSignature(fixture.bytes, fixture.signature, fixture.key)).not.toThrow()
    expect(() => verifyUpdaterSignature(Buffer.from('changed'), fixture.signature, fixture.key)).toThrow('verification failed')
    expect(() => verifyUpdaterSignature(fixture.bytes, fixture.signature, signedFixture().key)).toThrow('key mismatch')
    const commentTampered = Buffer.from(Buffer.from(fixture.signature, 'base64').toString().replace('timestamp:123', 'timestamp:124')).toString('base64')
    expect(() => verifyUpdaterSignature(fixture.bytes, commentTampered, fixture.key)).toThrow('verification failed')
  })
})
