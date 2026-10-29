# Project Overview

Helix is a Visual Studio Code extension that provides a chat-based coding assistant in a sidebar. It uses the DeepSeek Harness (DSH) runtime to manage model sessions and is designed to work with hosted and local models. The assistant can use relevant context from the active workspace, including selected editor text.

do not try and open it in chrome

do a patch version bump when you finish making changes

## Code organization (read before editing)

This codebase is deliberately organized by separation of concern. Large legacy files were split into focused modules (e.g. `extension.ts` → the `host/*` controllers, `dsh-control-plugin.ts` → `runtime/*` transport/approvals/preview/commands, and `gen-ui` → leaf modules). Facade files re-export the pinned public surface so tests and the webview keep importing from stable paths.

Rules for future changes:
- **Do not dilute the existing separation of concerns.** When you add code, put it in the module that already owns that concern. Do not append unrelated logic to a file just because it is convenient, and do not re-couple responsibilities that were deliberately split apart.
- **Prefer a new file for a new concern.** If what you are adding is a genuinely new responsibility, create a new focused module and wire it in, instead of growing an existing file.
- **Keep the pinned export surface stable.** If a symbol moved, keep the facade re-export so existing importers (tests, `src/webview`) keep working. Do not break test or webview import paths.
- **Re-verify against source, not summaries.** Before writing code that depends on exact behavior, read the real file — do not trust a description of what a module does.