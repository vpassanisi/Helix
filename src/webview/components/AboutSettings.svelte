<script lang="ts">
  import type { ExtensionInfo } from '../../shared/extension-info.js'
  let { info }: { info?: ExtensionInfo } = $props()
</script>

<div class="card about-card" data-size="sm">
  <header>
    <h3>{info?.name ?? 'Helix'}</h3>
    <p>A coding assistant for VS Code, powered by DeepSeek Harness. Works with hosted and local models.</p>
  </header>
  <section>
    <dl>
      <div><dt>Extension version</dt><dd>{info?.version ?? 'Unavailable'}</dd></div>
      <div><dt>VS Code version</dt><dd>{info?.vscodeVersion ?? 'Unavailable'}</dd></div>
      <div><dt>Runtime</dt><dd>DeepSeek Harness</dd></div>
      {#if info?.license}<div><dt>License</dt><dd>{info.license}</dd></div>{/if}
    </dl>
  </section>
</div>

<style>
  .about-card { min-width: 0; box-shadow: none; }
  .about-card header h3 { color: var(--brand-gold); font-size: 18px; font-weight: 650; letter-spacing: -.03em; }
  .about-card header p { max-width: 38ch; color: var(--muted-foreground); font-size: 11px; line-height: 1.6; }
  dl { display: grid; margin: 0; }
  dl > div { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 5px 14px; padding: 10px 0; font-size: 11px; }
  dl > div + div { border-top: 1px solid var(--border); }
  dt { color: var(--muted-foreground); }
  dd { min-width: 0; margin: 0; color: var(--foreground); overflow-wrap: anywhere; }
</style>
