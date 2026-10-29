<script lang="ts">
  import { onMount } from 'svelte'
  import { Plus, Settings2 } from '@lucide/svelte'
  import type { SettingsPage } from '../types.js'

  interface Props {
    onNewSession: () => void
    onOpenSettings: (page: SettingsPage) => void
  }

  let { onNewSession, onOpenSettings }: Props = $props()

  onMount(() => {
    const basecoat = (window as Window & { basecoat?: { init?: (component: string) => void } }).basecoat
    basecoat?.init?.('dropdown-menu')
  })

</script>

<header class="relative z-30 p-1 px-3 border-b border-[var(--border)]">
  <div class="relative flex min-h-[27px] items-center justify-start gap-2.5">
    <div class="flex min-w-0 items-center gap-[9px]">
      <h1 class="text-[17px] leading-[1.05] tracking-[-.035em] font-[650] text-[var(--brand-gold)]">Helix</h1>
    </div>

    <div class="absolute top-1/2 right-0 flex items-center gap-1 -translate-y-1/2">
      <button
        type="button"
        title="New session"
        aria-label="New session"
        onclick={onNewSession}
        class="btn h-[27px] w-[28px] p-0"
        data-variant="ghost"
        data-size="icon" >
        <Plus size={15} strokeWidth={1.8} />
      </button>
      <div
        class="dropdown-menu [&>[data-popover]]:z-50 [&>[data-popover]]:min-w-[180px] [&>[data-popover]]:p-1 [&_[role='menu']]:grid [&_[role='menu']]:gap-0.5 [&_[role='menuitem']]:min-h-[29px] [&_[role='menuitem']]:cursor-pointer [&_[role='menuitem']]:rounded [&_[role='menuitem']]:border-0 [&_[role='menuitem']]:bg-transparent [&_[role='menuitem']]:px-2 [&_[role='menuitem']]:py-1.5 [&_[role='menuitem']]:text-left [&_[role='menuitem']]:text-[11px] [&_[role='menuitem']]:font-normal [&_[role='menuitem']]:text-[var(--foreground)] [&_[role='menuitem']:hover]:bg-[var(--accent)] [&_[role='menuitem']:hover]:text-[var(--foreground)] [&_[role='menuitem'].active]:bg-[var(--accent)] [&_[role='menuitem'].active]:text-[var(--foreground)]"
      >
        <button
          type="button"
          id="settings-menu-trigger"
          title="Settings"
          aria-label="Settings"
          aria-haspopup="menu"
          aria-controls="settings-menu-list"
          aria-expanded="false"
          class="btn h-[27px] w-[28px] p-0"
          data-variant="ghost"
          data-size="icon">
          <Settings2 size={15} strokeWidth={1.8} />
        </button>
        <div id="settings-menu-popover" data-popover data-side="bottom" data-align="end" aria-hidden="true">
          <div role="menu" id="settings-menu-list" aria-labelledby="settings-menu-trigger" aria-label="Settings pages">
            <button type="button" role="menuitem" tabindex="-1" onclick={() => onOpenSettings('connection')}>Connection Settings</button>
            <button type="button" role="menuitem" tabindex="-1" onclick={() => onOpenSettings('models')}>Models</button>
            <button type="button" role="menuitem" tabindex="-1" onclick={() => onOpenSettings('tools')}>Tools</button>
            <button type="button" role="menuitem" tabindex="-1" onclick={() => onOpenSettings('mcp')}>MCP Servers</button>
            <button type="button" role="menuitem" tabindex="-1" onclick={() => onOpenSettings('preview')}>Request Previewer</button>
            <hr />
            <button type="button" role="menuitem" tabindex="-1" onclick={() => onOpenSettings('about')}>About Helix</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</header>
