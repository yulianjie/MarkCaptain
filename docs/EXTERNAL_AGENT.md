# External Agent document access (MCP)

MarkCaptain can share **one explicitly authorized editor buffer** with a local
MCP client. This includes unsaved text and the current selection. Access is off
by default and lasts only while that document and the Agent panel remain open.
Switching documents, closing the document/panel/window, revoking access, or a
renderer that stops responding invalidates the grant. Another window has its
own grant and cannot use this window's renderer commands.

## Connect

1. Open the document and its Agent panel. Expand **External Agent (MCP)** and
   choose **Authorize current document**. This grants read access to the whole
   current document; the selection is metadata, not a narrower permission.
2. The panel shows the command `node "<adapter path>"`. The application bundles
   `markcaptain-mcp.mjs`; in a source checkout use
   `node scripts/markcaptain-mcp.mjs`. Node.js 18 or newer is required.
3. Explicitly reveal the temporary credentials. Start that command as an MCP
   **stdio** server with `MARKCAPTAIN_MCP_PORT` and `MARKCAPTAIN_MCP_TOKEN` in its
   environment. Use your client's temporary environment/secret injection or
   inherit an ephemeral environment from its launcher. Do not put the token in
   a URL, command argument, shell history, project configuration, or Git. The
   panel's copy action copies only these temporary environment values and is
   available after you reveal them. Clear the clipboard after transferring them.
4. Ask your client to read the document and propose changes. Review the cards
   in the existing Agent panel, then let the client poll the review outcome.

The adapter uses newline-delimited JSON-RPC on stdin/stdout, implements MCP
initialization and the tools capability, and negotiates protocol versions
`2025-11-25`, `2025-06-18`, and `2025-03-26`. stdout contains protocol messages
only. It connects to a private **127.0.0.1 random port**, not an HTTP endpoint.
It never launches commands or reads files. The port and random capability are
kept in memory. Revocation requires a new grant and new credentials; the old
client configuration will stop working.

## Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `read_document` | `{}` or `{documentId}` | Current `markdown`, `selection`, display `name`, opaque `documentId`, monotonic `version`, UUID `snapshotId`, and full-document UTF-16 `anchor` |
| `propose_edit` | `{documentId, version, snapshotId, proposal: {title, changes}}` | `proposalId` and `pending`; changes enter the human review panel |
| `get_review_result` | `{documentId, proposalId}` | Overall and per-change review states, optional user reasons, conflicts, and migration information |

Each change contains `oldText`, `newText`, and optionally
`anchor: {snapshotId, from, to}`. Coordinates are **absolute UTF-16 code units**,
with an exclusive end; they cannot split a surrogate pair. Anchors select
specific occurrences of repeated text, and exact `oldText` still must match.
Without an anchor, the old text must occur exactly once; an empty old text
appends. Ranges must stay inside the document and cannot overlap. All changes
are validated again by the renderer using the same proposal validator as the
built-in Agent.

Read again and submit a new proposal after `staleVersion`. A version cannot
become current again by undoing back to identical text. Buffer changes
invalidate versions immediately; selection changes are captured when reading
or proposing. The server rejects cross-document requests, unknown fields,
unknown operations, revoked grants, invalid anchors, and stale versions.

Review statuses are `pending`, `applied`, `dismissed`, `reverted`, or `partial`.
`unverified` with `reviewStatus: "applied"` means the user accepted the change
but later edited that buffer; it is not proof the text still contains the edit.
If the user rebases pending changes for another review, feedback follows the
new cards, retains each original change `id`, and supplies the current
`reviewChangeId` with `rebased: true`. Conflicting changes carry `conflict: true`.
Clearing the conversation makes its review result `unavailable`.

## Boundaries and limits

There are no tools for arbitrary paths, other documents, filesystem reads,
applying edits, saving, network access, or Shell. Proposal acceptance and undo
stay in the existing human review UI. A capability authorizes any local process
that possesses it, so share it only with a trusted MCP client; this is not an
OS sandbox for that client's other capabilities.

The bridge allows at most four simultaneous connections and eight outstanding
requests, with bounded timeouts, a five-second renderer lease, 512 KB request
frames, and 12.5 MB response frames. Buffers are capped at 2 MB; proposals at
32 changes, 240 KB replacement text, and 32 submissions per grant. The adapter
uses stdin/stdout backpressure and stops on a burst exceeding 32 queued messages.
Document bodies, credentials, and MCP messages are never written to logs or
configuration by the bridge. Human review cards follow the application's
existing optional local conversation-history setting.

## Verification

`test/unit/agent-external.spec.ts` checks unsaved-buffer reads, duplicate-text
anchors, stale edit/undo versions, selection versions, cross-document requests,
revocation, review outcomes, migration, and a real spawned stdio adapter against
a loopback test bridge. Rust `agent_external` tests cover window ownership,
capability rejection, lease expiry, revocation, and bounded dispatch validation.

The MCP implementation follows the official [stdio transport requirements](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
[initialization lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle),
and [tool schemas/results](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
