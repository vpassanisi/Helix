# Helix for VS Code

I built this VS Code extension because I could not find a harness that gave me enough control over what gets sent to the model. That control is especially important when working with smaller local models.

I also could not find an app or extension that supported the workflow I wanted. Codex and Claude Code extensions are good, but their support for local models is limited and seems to be getting worse over time.

The goal is to provide a Codex style workflow with first class support for local models, while still allowing users to customize and optimize the experience for the models they use.


## Run locally

1. Install Node.js 22 or newer.
2. Run `npm install`.
3. Run `npm run compile` (builds the Svelte Webview and extension host).
4. Open this folder in VS Code.
5. Press `F5` to launch the Extension Development Host.
6. Open the Helix activity bar view.

To build an installable VSIX, run `npm run package`. The package command stages the production dependency tree, including the bundled DSH runtime, before creating the VSIX. Install the generated `local.helix-vscode-0.0.1.vsix` file in VS Code.

## Fast UI iteration

After launching the Extension Development Host with `F5`, run `npm run watch:webview` in a separate terminal. While the extension is running, edits to `src/webview` rebuild the bundle and refresh the sidebar automatically. The watcher is enabled only in Extension Development Host mode.

The extension uses `@deepseek-ai/dsh-sdk-client` to launch the matching bundled DSH SDK profile over stdio JSON-RPC. With no `deepseekHarness.dshBin`, it uses the installed `@deepseek-ai/dsh` package. Set `deepseekHarness.dshBin` to use a specific dsh CLI module.

## Runtime settings

Open the sidebar and select the gear button. The settings page configures only the provider route, API base URL, and API key. Models and context windows are discovered from the provider's models endpoint. API keys are stored in VS Code SecretStorage and are passed to the Harness subprocess as `DEEPSEEK_API_KEY`; they are not written to `settings.json`. The API URL is passed as `DEEPSEEK_BASE_URL`.

Custom OpenAI-compatible models may report a generic context fallback. The picker uses the selected model's reported context length when available; for an Unsloth `unsloth/gpt-oss-20b-GGUF` setup, that is `131072`. The extension passes this value to DSH as a startup patch for both the DeepSeek and OpenAI-compatible model adapters, so DSH's automatic compaction threshold is based on that limit.

The full `sdk` profile includes automatic compaction. When DSH reaches its configured threshold, it emits compaction events, summarizes older context, keeps the recent conversation tail, and continues the session. The sidebar displays that lifecycle in the transcript.

The chat model picker discovers models from an OpenAI-compatible `GET /models` endpoint. If the configured base URL does not end in `/v1`, the extension also tries `/v1/models`. It sends the saved API key as a Bearer token, reads `data[].id`, and uses `native_context_length`, `max_context_length`, or `context_length` when present. Selecting a discovered model saves its model ID and context length, then restarts DSH with the selected values.

Saving connection settings automatically starts or restarts the runtime with the new values. The default provider is `deepseek-official`, the default model is `deepseek-v4-flash`, and the default API URL is `https://api.deepseek.com`.

## MCP servers

Open the sidebar settings and use **Add server** in the MCP servers section. A new server is prefilled for the local DuckDuckGo Docker MCP:

```text
Command: docker
Arguments:
run
-i
--rm
mcp/duckduckgo
```

Save the settings and the extension restarts DSH. DSH launches the Docker command over stdio; Docker Desktop must be running, but the container does not need to be started separately. The server's tools are exposed to the model as `mcp__duckduckgo__<tool>`.

Environment variable values entered for stdio servers are stored in VS Code SecretStorage. The generated DSH patch contains only references to process environment variables, never the secret values. MCP servers run at the DSH runtime level and are available to all sessions in that runtime.

The extension disables DSH's built-in Web Search and Web Fetch tools. Use an MCP server such as DuckDuckGo for web access instead, so the model does not call the built-in DeepSeek web route with the connection API key.

## Agent questions

The main agent can call `ask_user_question` to pause its turn and show a question card in the conversation. Each question has two or three choices, exactly one recommendation, and a custom-response input. Submit an answer to continue the same turn, or use Stop to cancel. Pending questions return when the sidebar reopens; restarting the runtime cancels them.

## Editor context

With a non-empty editor selection, the current selection is captured when the prompt is submitted. It is sent as a text `ContentBlock` before the user prompt. The sidebar displays the selected file and range, and the selection can be removed for the current prompt.

## Browser element context

Open a page in VS Code's integrated browser, then use the pointer button in the Helix composer or **Helix: Select Browser Elements**. The blue outline follows the element under your mouse. Click to attach its HTML and computed CSS; keep clicking to select more elements, and press Escape to finish. Review or remove the attachment cards, type your instructions, and send. No screenshots are captured or sent.

This experimental feature uses VS Code's proposed `browser` API and is intended for private VSIX installs. In **Preferences: Configure Runtime Arguments**, add `"enable-proposed-api": ["local.helix-vscode"]` and fully restart VS Code. The feature has been developed against VS Code 1.140.0; older builds without the API keep ordinary chat available. Proposed APIs can change with VS Code updates and should not be used in ordinary Marketplace releases.

The picker supports the main document, same-origin frames, and open shadow roots. Cross-origin frames and closed shadow roots are not supported. Selection stops on navigation or tab closure, while existing attachments remain as snapshots. A new chat clears them. `deepseekHarness.maxBrowserContextCharacters` limits the combined HTML/CSS sent per prompt (32,000 characters by default); truncated attachments are marked.

## Notification routing

The runtime emits notifications for every session. The extension uses one runtime subscription and routes `session.event` and `session.status` by `sessionId`. Subagent lineage is tracked from `subagent.started` so a session-tree view can display descendant activity without exposing unrelated sessions.

## Webview UI

The UI uses Basecoat CSS primitives with a custom shadcn-compatible monochrome token theme in `src/webview/theme.css`. It uses a near-black canvas, off-white primary actions, subtle gray borders, and Lucide icons. The UI communicates with the extension host through `postMessage`; it does not assume native VS Code controls.
