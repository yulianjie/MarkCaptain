# Storage plugin protocol v1

Storage plugins are the only supported route for cloud providers other than
MarkCaptain Sync, Git, and WebDAV. A plugin is an explicitly installed native
executable plus a reviewed manifest. MarkCaptain does not load plugin code into
the WebView or the application process.

Plugins are trusted native programs running as the current OS user. Process,
path, protocol, environment, and size restrictions reduce accidental exposure
but do not constitute an OS sandbox. Users must review and trust a plugin
before installing it.

## Installation layout

Install one plugin below the application configuration directory:

```text
storage-plugins/
  example-cloud/
    storage-plugin.json
    example-cloud-provider[.exe]
```

The manifest id must match the directory selected by the connection. The
executable is canonicalized and must stay below `storage-plugins`; symlink and
`..` escapes are rejected.

```json
{
  "manifestVersion": 1,
  "id": "example-cloud",
  "displayName": "Example Cloud",
  "version": "1.0.0",
  "protocolVersion": 1,
  "executable": "example-cloud-provider.exe",
  "arguments": [],
  "capabilities": {
    "conditionalWrite": true,
    "incrementalChanges": false,
    "atomicMove": true,
    "versionHistory": false,
    "stableFileId": true,
    "caseSensitive": true
  }
}
```

## Transport

For each operation MarkCaptain starts the executable directly, without a shell.
It writes one newline-terminated JSON-RPC 2.0 request to stdin, closes stdin,
and reads one bounded response from stdout. Stderr is discarded. The process
has a deadline and is terminated on timeout.

```json
{
  "jsonrpc": "2.0",
  "id": "request-uuid",
  "method": "storage/list",
  "params": {
    "protocolVersion": 1,
    "configuration": { "account": "notes" },
    "credential": "opaque secret when configured",
    "path": "folder"
  }
}
```

Secrets are supplied only through stdin. They never appear in the manifest,
connection file, process arguments, environment variables, URLs, or logs.
Non-secret `configuration` is limited in size/depth and rejects secret-like
keys recursively.

Successful response:

```json
{"jsonrpc":"2.0","id":"request-uuid","result":{}}
```

Plugin error messages are untrusted and are not forwarded to the UI. MarkCaptain
surfaces a stable protocol error instead.

## Methods

- `storage/probe` -> provider capabilities
- `storage/list` -> `RemoteEntry[]`
- `storage/read` -> `{ version? }`; MarkCaptain supplies
  `transfer.outputPath` and reads only that exact app-created file.
- `storage/write` -> opaque `RemoteVersion`; MarkCaptain writes the bytes to
  `transfer.inputPath` before launch and supplies that path to the plugin.
- `storage/createDir` -> opaque `RemoteVersion`
- `storage/move` -> opaque `RemoteVersion`
- `storage/delete` -> `null`
- `storage/changes` -> `{ cursor, changes }` when declared

Paths are normalized workspace-relative strings. Binary bytes never travel as
JSON arrays. Transfer files live in a private, per-request temporary directory
and are removed when the operation ends. Plugins cannot nominate a different
path; output is rejected when it is a symlink/reparse point, is not a regular
file, or exceeds the manifest limit (with an absolute 64 MiB ceiling).

Writes must honor the provided `match` or `missing` precondition. A plugin that
cannot guarantee a conditional write must declare `conditionalWrite: false`;
MarkCaptain will not silently downgrade to last-writer-wins.

Plugins may report fewer capabilities at runtime than their manifest declares,
but cannot acquire additional capabilities without a manifest update.
