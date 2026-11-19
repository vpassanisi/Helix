# Upstream source

- Repository: https://github.com/vpassanisi/dsh-otel-plugin
- Plugin version: `0.4.2`
- Base revision: `ca4cd706d00c9aefe0327f574a31b41deb868078`

This snapshot is the upstream working tree taken on 2026-11-15, which sits on top of the base revision with uncommitted work: version `0.2.0` adds content-addressed message refs. Version `0.2.1` parents `execute_tool` spans on the `invoke_agent` root, so a tool span never starts after its parent closes. Version `0.3.0` makes one turn one trace and gives that trace every entry it names: the publishing watermark resets at `turn/start`, the turn root carries the prompt-section entries, and `dedupeScope`, `selfContained`, `storeEndpoint`, and `src/store.ts` are gone. Version `0.4.0` spans the watermark across the conversation: each entry publishes once at its birth span, a resync is a checkpoint of the full context as an ordered ref list, the checkpoint cadence defaults to 16 spans counted per conversation, `resyncOn` defaults to `exportGap` and `unknownEvent`, the watermark is a bounded LRU with the new `watermarkMaxEntries`, an export gap rebirths entries born since the last checkpoint, and `dsh.messages_complete` reports map completeness. The same release fixes `endTool` to read `toolCallId` and `isError` as top-level `ToolResultMessage` fields, so a successful tool span closes on its result event and never carries `error.type: cancelled`. The eight files in `src/` are byte-identical to upstream. Commit the upstream tree and refresh the base revision here once that work lands.

New in this snapshot, relative to `ca4cd70`: `refs.ts`, `store.ts`, `resolve.ts`, and `dsh-events.ts`, plus 12 configuration options that Helix exposes under `deepseekHarness.otelTracing`. See the plugin `README.md` for the ref format, the resync layers, and the measured byte cost.

`0.4.1` folds `gen_ai.usage.cache_read.input_tokens` and the written-cache bucket into `gen_ai.usage.input_tokens`, and recomputes `gen_ai.usage.total_tokens` from that sum plus `output_tokens`. DSH reports those counts disjoint, with `inputTokens` as uncached input only, while OTel GenAI and OpenInference both define the cache buckets as subsets of the input total. Phoenix prices a span on that shape, so the export must carry it.

`0.4.2` renames the written-cache attribute to the registry name `gen_ai.usage.cache_creation.input_tokens` and emits `gen_ai.usage.reasoning.output_tokens` from `reasoningTokens`, a subset of `output_tokens`. A probe span sent over OTLP to Phoenix 20.21.2 settled the names: `cache_creation.input_tokens` projects to `llm.token_count.prompt_details.cache_write`, while `gen_ai.usage.cache_write.input_tokens` is stored raw and ignored by the converter. `reasoning.output_tokens` is stored raw and not projected by that Phoenix version, so it is registry-correct and forward-compatible.

Keep the plugin's own repository as the source of truth and refresh this folder from a reviewed upstream revision when updating it.

## Build contract in Helix

- Built by `npm run build:plugins` (tsdown, ESM, no bundling of dependencies). `@deepseek-ai/schemastery`, `@grpc/grpc-js`, and the OpenTelemetry packages stay external and resolve from the Helix extension's `node_modules`.
- Helix declares every runtime import the bundle needs, including the peer dependency `@deepseek-ai/dsh-system-prompt`, imported lazily by specifier so a missing package degrades to whole-prompt refs. Section refs and surface pointers need DSH `0.2.1-rc.2` or newer, which Helix pins.
- The upstream package declares `@deepseek-ai/cordis` `^4.0.4`, and Helix pins Cordis `~4.0.5`. The bundle imports Cordis types only, so Cordis is not a runtime import in the plugin bundle; an SDK-profile smoke test is still needed to confirm hook behavior.
