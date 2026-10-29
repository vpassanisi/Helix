<script lang="ts">
  import type { ExtensionInfo } from '../../shared/extension-info.js'
  let { info }: { info?: ExtensionInfo } = $props()
</script>

<div class="card flex-none min-w-0 shadow-none" data-size="sm">
  <header>
    <h3 class="text-[var(--brand-gold)] text-[18px] font-[650] tracking-[-0.03em]">{info?.name ?? 'Helix'}</h3>
    <p class="max-w-[38ch] text-[var(--muted-foreground)] text-[11px] leading-[1.6]">A coding assistant for VS Code, powered by DeepSeek Harness. Works with hosted and local models.</p>
  </header>
  <section>
    <dl class="grid m-0 [&>div+div]:border-t [&>div+div]:border-[var(--border)]">
      <div class="flex flex-wrap items-baseline justify-between gap-x-[14px] gap-y-[5px] py-[10px] text-[11px]"><dt class="text-[var(--muted-foreground)]">Extension version</dt><dd class="min-w-0 m-0 text-[var(--foreground)] [overflow-wrap:anywhere]">{info?.version ?? 'Unavailable'}</dd></div>
      <div class="flex flex-wrap items-baseline justify-between gap-x-[14px] gap-y-[5px] py-[10px] text-[11px]"><dt class="text-[var(--muted-foreground)]">VS Code version</dt><dd class="min-w-0 m-0 text-[var(--foreground)] [overflow-wrap:anywhere]">{info?.vscodeVersion ?? 'Unavailable'}</dd></div>
      <div class="flex flex-wrap items-baseline justify-between gap-x-[14px] gap-y-[5px] py-[10px] text-[11px]"><dt class="text-[var(--muted-foreground)]">Runtime</dt><dd class="min-w-0 m-0 text-[var(--foreground)] [overflow-wrap:anywhere]">DeepSeek Harness</dd></div>
      {#if info?.license}<div class="flex flex-wrap items-baseline justify-between gap-x-[14px] gap-y-[5px] py-[10px] text-[11px]"><dt class="text-[var(--muted-foreground)]">License</dt><dd class="min-w-0 m-0 text-[var(--foreground)] [overflow-wrap:anywhere]">{info.license}</dd></div>{/if}
    </dl>
  </section>
</div>
