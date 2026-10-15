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
