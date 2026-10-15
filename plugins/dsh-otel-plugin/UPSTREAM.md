# Upstream source

- Repository: https://github.com/vpassanisi/dsh-otel-plugin
- Revision: `ca4cd706d00c9aefe0327f574a31b41deb868078`

This source snapshot is built with Helix's `npm run build:plugins` command. Keep the plugin's own repository as the source of truth and refresh this folder from a reviewed upstream revision when updating it.

The upstream package declares `@deepseek-ai/cordis` `^4.0.4`, and Helix pins Cordis `4.0.4`. The bundle imports Cordis types only, so Cordis is not a runtime import in the plugin bundle; an SDK-profile smoke test is still needed to confirm hook behavior.
