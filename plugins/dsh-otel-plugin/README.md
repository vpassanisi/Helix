# DSH OpenTelemetry tracing plugin

This standalone DSH bundle exports agent, model, and tool spans over OTLP. Every finished span is sent to each configured destination using that destination's own protocol and batch processor.

## Install

Build or download the package, then install it into a DSH profile:

```sh
npm install
npm run build
dsh plugin --profile sdk add file:/absolute/path/to/dsh-otel-plugin
```

The bundle patch registers the plugin with tracing disabled. Edit the profile patch to enable it and configure one or more destinations. The plugin uses DSH `0.2.1-rc.2` session events and Cordis lifecycle hooks; prompt-section refs need that version or newer.

## Configuration

```yaml
enabled: true
serviceName: dsh
endpoints:
  - url: https://collector-one.example/v1/traces
    protocol: http/protobuf
    headers:
      authorization: "Bearer <runtime-supplied-token>"
    timeoutMs: 5000
  - url: https://collector-two.example:4317
    protocol: grpc
    headers:
      x-api-key: "<runtime-supplied-key>"
    timeoutMs: 8000
```

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `false` | Enables span creation and export. |
| `serviceName` | `dsh` | Sets the shared OTEL `service.name` resource attribute. |
| `endpoints` | `[]` | Export destinations. An empty list creates no exporters. |
| `endpoints[].url` | required | Complete HTTP trace URL, including `/v1/traces`, or a gRPC target such as `collector:4317` or `unix:///path/to/socket`. |
| `endpoints[].protocol` | `http/protobuf` | Selects `http/protobuf` or `grpc`; `http/json` is not supported. |
| `endpoints[].headers` | `{}` | Optional map of header names to values, sent as HTTP headers or gRPC metadata. |
| `endpoints[].timeoutMs` | `5000` | Per-destination export timeout, from 100 to 120000 milliseconds. |
| `capturePrompts` | `false` | Adds redacted model input messages to `gen_ai.input.messages`. |
| `captureResponses` | `false` | Adds redacted model output messages to `gen_ai.output.messages`. |
| `captureToolArguments` | `false` | Adds redacted arguments to `gen_ai.tool.call.arguments` and captured tool-call messages. |
| `maxContentLength` | `8192` | Maximum serialized length for each captured content attribute. |
| `inputMessagesMode` | `full` | Shape of `gen_ai.input.messages`: `full`, `refs`, `objects`, `checkpoint`, `omit`. See Message refs. |
| `maxSpansBetweenResyncs` | `4` | Chat spans without a resync before the full ordered ref list is republished. `0` disables the watchdog. |
| `resyncOn` | all triggers | Layer-2 resync triggers: `userMessage`, `promptSections`, `toolSet`, `route`, `compaction`, `feedback`, `splice`, `seed`, `surfaceReplace`, `runtimeContext`, `turnRoot`, `exportGap`, `unknownEvent`. |
| `refHashLength` | `12` | Hex characters of the truncated SHA-256 ref, 8 to 16. 12 is 48 bits. |
| `refEncoding` | `base64url` | `base64url` packs a full list (8 characters per 48-bit ref); `hex` emits a queryable string array. |
| `messageEntryMaxBytes` | `8192` | Per-entry cap applied before hashing, so a ref names exactly the published bytes. 64 to 65536. |
| `captureSystemPromptSections` | `true` | Publish per-section refs for the system prompt and for runtime-context snapshots. |
| `contextPointers` | `true` | Emit `dsh.surface_seq_start`, `dsh.surface_seq_end`, `dsh.surface_generation` so a log-connected resolver can repair. |
| `exportGapResyncs` | `true` | Force a resync after a counted export shortfall. |

Header values are passed through as configured; the plugin does not store credentials or resolve them from environment variables. A host integration can read credentials from its secret store and populate `headers` when it builds runtime config. Avoid committing real credentials in a persistent profile patch.

For gRPC, these headers are sent as request metadata. HTTP headers and gRPC metadata are configured independently for each destination. OTEL's standard `OTEL_EXPORTER_OTLP_*_ENDPOINT` and `*_PROTOCOL` variables do not select destinations; configure destinations in `endpoints`. `OTEL_SERVICE_NAME` continues to override `serviceName`. Standard exporter TLS environment settings may also be applied by the underlying exporters.

All content capture is opt-in. Captured strings redact common credential fields, bearer tokens, token-shaped keys, JWTs, and email addresses. Images and files are represented by their type only. Oversized values are truncated and marked. Tool results are not copied to tool spans.

## Trace scope

One turn is one trace. The trace opens on `turn/start`, when the user sends a message, and
closes on `turn/end`, when the agent gives the final response. A new user message opens a new
trace. Subagents are separate sessions, so each has its own trace, linked to the parent root.

A trace carries everything needed to reconstruct it. The publishing watermark resets at
`turn/start`, so the trace re-publishes every entry it names, prompt sections included. The
`invoke_agent` root names the prompt sections in `dsh.system_prompt_refs` and carries their
entries in its own `dsh.messages` map. The first `chat` span of the trace is a resync: it
publishes the full ordered ref list. A consumer needs no span, no store, and no log from an
older trace.

Spans use `invoke_agent` roots, `chat` children per model attempt, and `execute_tool` children correlated by tool call ID. `execute_tool` spans nest under the `invoke_agent` root, not under the `chat` span that requested the call, because the chat span closes when the model stream ends. Retries create separate chat spans. Child agent roots link to a known parent session span. Stream frames record first-token timing. Each destination has its own batch queue; a failed export to one endpoint does not interrupt DSH event handling or another endpoint's processor. Exporter and shutdown failures are contained.

## Message refs

With `inputMessagesMode` set to anything but `full`, the plugin stops repeating the whole
context on every model call. Each message becomes a short content hash, a span publishes
only content the trace has not published before, and a **resync** span publishes the full
ordered list so a consumer realigns. The system prompt decomposes into one ref per prompt
section, and a runtime-context snapshot decomposes into its named sections.

### Refs and attributes

A ref is the truncated SHA-256 of the exact published bytes: after redaction, after the
per-entry cap. A resolved entry equals the bytes the ref names, byte for byte. Refs identify
content, not messages, so identical tool results and identical prompt sections share one entry.

| Attribute | Type | Content |
| --- | --- | --- |
| `dsh.resync` | boolean | `true` when this span carries the authoritative full ordered list. |
| `dsh.resync_reason` | string | Comma-separated causes: `session_start`, `watchdog`, `prefix_broken`, `user_message`, `prompt_sections`, `tool_set`, `route`, `compaction`, `feedback`, `splice`, `seed`, `surface_replace`, `runtime_context`, `turn_root`, `export_gap`, `unknown_event`. |
| `dsh.resync_index` | number | Resync ordinal inside the trace, so a consumer can tell a missing resync from a late one. The counter restarts at each `turn/start`. |
| `dsh.message_refs_packed` | string | Full ordered ref list, base64url over 6 raw bytes per ref. Resync spans only. |
| `dsh.message_refs` | string array | New input refs on a delta span; the full list when `refEncoding: hex`. |
| `dsh.output_refs` | string array | Ref of the assistant message this span produced, so outputs append with the same mechanics. |
| `dsh.messages` | JSON string | `{ "<ref>": <entry> }` map of entries new to the trace watermark, on the turn root and on chat spans. A map cannot be an OTel attribute value, so it is a JSON string. |
| `dsh.messages_complete` | boolean | `true` when every ref this span names resolves from this span alone: `true` on a turn root that carries its section entries, and on the first chat span of a trace. |
| `dsh.context_root`, `dsh.prev_context_root` | string | Hash of the ordered ref list and its predecessor: an integrity check, a prefix cache key, and the consumer's drift detector. |
| `dsh.system_prompt_refs`, `dsh.system_prompt_root` | string array, string | Ordered prompt-section refs and their hash, on the turn root span, whose `dsh.messages` map carries the section entries. Chat spans repeat the ref list. |
| `dsh.system_prompt_decomposed` | boolean | `false` when the section join did not equal the system message in history, so the refs cover one whole prompt. |
| `dsh.tool_root` | string | Hash over the visible tool schemas. |
| `dsh.surface_seq_start`, `dsh.surface_seq_end`, `dsh.surface_generation`, `dsh.event_seq` | number | Pointers into the durable session log, the repair rung. |
| `dsh.export_gap` | boolean | Set after a counted export shortfall; forces a resync. |
| `dsh.ref_algorithm`, `dsh.ref_encoding` | string | `sha256-<len>` and `base64url` or `hex`, so refs are self-describing. |
| `dsh.ref_collision`, `dsh.refs_truncated`, `dsh.entries_truncated` | boolean | Explicit markings for the rare widen, the trimmed list, and the trimmed map. |

Prompt-section entries carry `name`; a snapshot entry nests section refs, and the resolver
rejoins them with blank lines, exactly as DSH renders them.

### Resync triggers

Two layers. Layer 1 is structural and always on, so the guarantee never depends on knowing an
event name:

- `prefix_broken`: the previous span's ordered ref list must be a prefix of this span's list.
  A rewrite, prune, splice, seed, rewind, or reorder breaks the prefix.
- `prompt_sections` and `tool_set`: the section-root and tool-root hashes change.

Layer 2 subscribes to events so a resync lands on the earliest possible span: a user message,
`system/message`, `developer/message` tool-registry blocks, compaction, feedback, inbox splice,
`session/end-seed`, `image/offload`, `request/header`, `request/context`, model and preset
selection, working directory, sandbox mode, approval policy, permission preset, plan mode,
goal and todo writes, and subagent catalog changes. An event type outside the DSH catalog, and
any `plugin:` record, triggers a resync. A `system-prompt/change` on the Cordis context marks
every session dirty, so a section registration resyncs on the next span.

### Reconstruction

`resolveMessages(spans)` in `src/resolve.ts` is the normative contract, mirrored by the Go
ingest. Feed it the spans of one trace. Rules, in span order per `gen_ai.conversation.id`:

1. Merge every `dsh.messages` map into one ref-keyed store.
2. On a `dsh.resync: true` span, adopt its full ordered list and discard accumulated state.
3. On a delta span, append its `dsh.message_refs` and the `dsh.output_refs` of the previous span.
4. Verify the accumulated list against `dsh.context_root`; a mismatch marks the span `partial`.
5. Dereference entries and nested `sections`; report a missing entry as `{ "unresolved": "<ref>" }`.

Repair ladder, cheapest first: the span's own map, the nearest resync span, any span of the
same trace, the session-log pointer. A trace carries every entry it names, so the ladder never
has to leave the trace.

### Measured cost

Measured on 8 real session logs, 3,346 chat spans, 78 turns, 6,654 unique messages, with the
plugin's own mapper, redaction, and caps. `DSH_OTEL_MEASURE_SESSIONS=1 npm test` re-derives
this table from `~/.dsh/sessions`.

| Shape | Bytes per span | Total | vs baseline | Damage from one dropped span |
| --- | --- | --- | --- | --- |
| Lossless full context, uncapped | 503 KB | 1,693 MB | +6,030% | 1 span |
| Baseline: full context capped at 8192 (the shipped default) | 8,192 | 27.55 MB | — | 1 span, over 98% of every capture destroyed |
| Refs, cadence 4 inside one trace per turn (the shipped ref default) | 3,425 | 11.52 MB | −58.2% | ≤4 spans, and detected |
| Refs, full list on every span of the trace | 5,210 | 17.52 MB | −36.4% | 1 span, lossless per entry |

Measured on 8 session logs, 3,363 chat spans, 80 turns.

Two facts the table fixes in place.

A dropped span is unrecoverable in every scheme. No span in the corpus is content-free, so each
span is the only carrier of its own assistant message and tool results. Resync points do not
save the dropped span; they bound how far the loss travels and make the break visible:
`dsh.context_root` mismatches mark the exact span `partial`, and the damage is one contiguous
run that ends at the next resync.

Trace scope costs a turn the entries it names. A long conversation re-publishes its history at
the start of each turn, which is the price of a trace that resolves alone. The saving against
the capped baseline survives because a trace publishes each entry once, not once per span.

Prompt sections are where the redundancy concentrates: ~9.8 KB per prompt, 24 sections, median
272 characters, 38 unique sections across all 8 sessions, and 19 KB of runtime-context
snapshots of which about 1 KB is unique. Each trace publishes them once, on its own root.

### `gen_ai.input.messages` with refs

`inputMessagesMode: 'refs'` puts the ordered ref list in `gen_ai.input.messages`. Upstream types
the attribute `any` and requires an AnyValue conforming to `model/gen-ai/gen-ai-input-messages.json`,
whose `ChatMessage` requires `role` and `parts` with `additionalProperties: true`. A list of bare
hashes therefore violates conformance, not the wire: the OTel JS SDK validates nothing and OTLP
`AnyValue` carries string arrays. Consumers that JSON-schema-check gen_ai attributes show an empty
prompt; they do not drop spans. `gen_ai.input.messages_ref` already means an absolute URI to
external storage upstream, so a hash ref there is a DSH-local convention. `inputMessagesMode:
'objects'` keeps the same refs in schema-valid form as `{ "role": "user", "parts": [], "ref": "<ref>" }`.
The vendor views will not render a prompt in these modes; a resolver will.

### Refs are not redaction

A ref is a deterministic identifier over redacted text. A party holding the store and a known
corpus can confirm that a known text appears in a session, and the ref list reveals message
counts and ordering. Access-control the store. Redaction itself runs before hashing, so a
credential never enters an entry, a ref, or a digest, and two messages that differ only by a
secret share one ref.

### DSH version

Section refs and surface pointers need DSH `0.2.1-rc.2` or newer, for `system-prompt/assemble`,
`ContextSnapshotSection`, and `deriveMessages`. Without `@deepseek-ai/dsh-system-prompt`
resolvable in the profile, `captureSystemPromptSections` degrades to one ref for the whole
prompt and logs one warning.

## Migrating from a single endpoint

Replace top-level `endpoint`, `protocol`, and `exportTimeoutMs` settings with an `endpoints` list. Move the old endpoint and protocol values into one item and set its `timeoutMs` if needed. The previous OTEL endpoint and protocol variables no longer select the destination; use per-endpoint URLs and protocols in the profile. Replace each `headersEnv` entry with a `headers` map. Hosts that manage secrets should resolve them from secure storage and supply the header values in runtime config.

## Development

```sh
npm test                # unit and contract tests
npm run typecheck
npm run build
npm pack
DSH_OTEL_MEASURE_SESSIONS=1 npm test   # adds the real-corpus byte measurement
```

`test/resolve.test.ts` is the resolver contract: it drops spans from a recorded set and asserts
that the damage is contiguous, bounded by `maxSpansBetweenResyncs`, and never silent. A Go port
of the resolver in collector ingest is correct when it passes the same rules.
