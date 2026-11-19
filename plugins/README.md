# DSH plugins in Helix

Helix injects registered DSH bundles into its per-launch SDK profile patch. The bundled OTEL plugin is controlled through `deepseekHarness.otelTracing` in VS Code settings. It registers with tracing disabled by default, and its content capture options are off.

To add another local bundle, build its JavaScript entry first, then add an item to `deepseekHarness.plugins`:

```json
{
  "id": "example-plugin",
  "path": "/absolute/path/to/example-plugin/dist/index.mjs",
  "enabled": true,
  "config": {}
}
```

Relative paths resolve from the Helix extension folder. Plugin IDs must be unique. Only enable bundles you trust; DSH loads them into its runtime. Keep credentials in environment variables or VS Code SecretStorage rather than plugin config.

The OTEL source snapshot and its upstream revision are recorded in `dsh-otel-plugin/UPSTREAM.md`.

## OTEL message content modes

The bundled plugin is version 0.4.0. It ships two shapes for model input:

- `full` repeats the captured context on every span. This is the default, and the behaviour of earlier Helix builds.
- The ref modes (`refs`, `objects`, `checkpoint`, `omit`) publish each message once per conversation under a content hash, at the span that first names it, and send the hash in its place. A resync span is a checkpoint: it marks the full context as the ordered ref list, without restating published payloads. One dropped span then costs a bounded run of spans to the next checkpoint, `dsh.context_root` marks the span where the break lands, an export gap rebirths entries born since the last checkpoint, and the watermark LRU rebirths entries evicted from `watermarkMaxEntries`.

One user turn is one trace. The trace opens at `turn/start` and closes at `turn/end`. The trace carries every payload born during its turn, and a checkpoint names the whole context in refs: a trace rebuilds its own turn, and the full context of a span rebuilds from the pooled traces of the conversation, queried by `gen_ai.conversation.id`.

`deepseekHarness.otelTracing` carries every plugin setting: `inputMessagesMode`, `maxSpansBetweenResyncs`, `resyncOn`, `refHashLength`, `refEncoding`, `messageEntryMaxBytes`, `watermarkMaxEntries`, `captureSystemPromptSections`, `contextPointers`, and `exportGapResyncs`. The sidebar shows them under **Connection settings → OpenTelemetry tracing → Message content refs**.

Helix validates the settings on save, so a value the plugin schema rejects reports in the sidebar instead of disabling tracing at runtime. `plugins/dsh-otel-plugin/README.md` documents the ref format, the checkpoint layers, and the measured byte cost.
