<script lang="ts">
  import { Check, LoaderCircle, Plus, Server, Trash2, X } from '@lucide/svelte'
  import type { McpServerDraft } from '../types.js'

  interface Props {
    mcpServers: McpServerDraft[]
    mcpSaving: boolean
    settingsRestarting: boolean
    onSave: () => void
  }

  let { mcpServers = $bindable(), mcpSaving, settingsRestarting, onSave }: Props = $props()
  const applying = $derived(mcpSaving || settingsRestarting)
  const environmentInputClass = 'input min-w-0 h-[26px] px-[7px] py-0 text-[10px]! [font-family:var(--vscode-editor-font-family,monospace)]!'

  function addMcpServer(): void {
    mcpServers = [{
      serverName: '',
      transport: 'stdio',
      command: '',
      argsText: '',
      url: '',
      env: [],
    }, ...mcpServers]
  }

  function removeMcpServer(index: number): void {
    mcpServers = mcpServers.filter((_, currentIndex) => currentIndex !== index)
  }

  function addMcpEnvironment(index: number): void {
    mcpServers[index].env = [...mcpServers[index].env, { name: '', value: '', configured: false }]
  }

  function removeMcpEnvironment(serverIndex: number, environmentIndex: number): void {
    mcpServers[serverIndex].env = mcpServers[serverIndex].env.filter((_, index) => index !== environmentIndex)
  }
</script>

<div class="flex-none grid gap-[15px]">
  <section class="m-0 min-w-0 p-0" aria-labelledby="mcp-settings-title">
    <h3 id="mcp-settings-title" class="mt-0 mb-[5px] text-[11px] font-[650] tracking-[.04em] text-[var(--foreground)]">MCP servers</h3>
    <div class="mt-0 mb-[12px] flex items-start justify-between gap-[10px] [@media(max-width:360px)]:flex-col">
      <div>
        <p class="mt-[3px]! text-[10px] leading-[1.4] text-[var(--muted-foreground)]">Attach local Docker or HTTP tool servers to the DSH runtime.</p>
      </div>
      <button class="btn inline-flex h-[27px] flex-none items-center gap-[5px] px-[8px] py-0 text-[10px]! [@media(max-width:360px)]:self-start" data-variant="outline" type="button" onclick={addMcpServer}>
        <Plus size={13} strokeWidth={1.8} /> Add server
      </button>
    </div>

    {#if mcpServers.length === 0}
      <div class="flex items-center gap-[7px] pt-[11px] pb-[2px] text-[10px] text-[var(--muted-foreground)]">
        <Server size={15} strokeWidth={1.7} />
        <span>No MCP servers configured.</span>
      </div>
    {:else}
      <div class="grid gap-[10px]">
        {#each mcpServers as server, serverIndex (server)}
          <fieldset class="m-0 min-w-0 rounded-[var(--radius)] border border-[#343b42] bg-[var(--composer)] px-[10px] pt-[12px] pb-[10px] [&>.field]:mt-[10px]">
            <legend class="flex w-full items-center justify-between px-[4px] py-0 text-[11px] font-semibold text-[var(--foreground)]">
              <span class="inline-flex min-w-0 items-center gap-[6px] truncate"><Server size={13} strokeWidth={1.7} /> {server.serverName || 'Unnamed server'}</span>
              <button class="btn h-[24px] w-[24px] p-0 text-[var(--muted-foreground)]!" data-variant="ghost" data-size="icon" type="button" aria-label={`Remove ${server.serverName || 'MCP server'}`} title="Remove MCP server" onclick={() => removeMcpServer(serverIndex)}>
                <Trash2 size={13} strokeWidth={1.8} />
              </button>
            </legend>

            <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-[10px] [@media(max-width:360px)]:grid-cols-1">
              <div class="grid gap-1.5" role="group">
                <label for={`mcp-name-${serverIndex}`}>Server name</label>
                <input id={`mcp-name-${serverIndex}`} class="input" bind:value={server.serverName} placeholder="Server name" autocomplete="off" />
                <small class="block!">Used in tool names</small>
              </div>

              <div class="grid gap-1.5" role="group">
                <label for={`mcp-transport-${serverIndex}`}>Transport</label>
                <select id={`mcp-transport-${serverIndex}`} class="select" bind:value={server.transport}>
                  <option value="stdio">Local process / Docker</option>
                  <option value="streamable-http">Streamable HTTP</option>
                </select>
              </div>
            </div>

            {#if server.transport === 'stdio'}
              <div class="grid gap-1.5" role="group">
                <label for={`mcp-command-${serverIndex}`}>Command</label>
                <input id={`mcp-command-${serverIndex}`} class="input" bind:value={server.command} placeholder="Executable or path" autocomplete="off" />
                <small class="block!">DSH starts this command when the runtime starts.</small>
              </div>

              <div class="grid gap-1.5" role="group">
                <label for={`mcp-args-${serverIndex}`}>Arguments</label>
                <textarea id={`mcp-args-${serverIndex}`} class="textarea min-h-[76px] resize-y text-[11px]! leading-[1.45]! [font-family:var(--vscode-editor-font-family,monospace)]!" bind:value={server.argsText} rows="4"></textarea>
                <small class="block!">One argument per line.</small>
              </div>
            {:else}
              <div class="grid gap-1.5" role="group">
                <label for={`mcp-url-${serverIndex}`}>MCP URL</label>
                <input id={`mcp-url-${serverIndex}`} class="input" type="url" bind:value={server.url} placeholder="http://localhost:3000/mcp" autocomplete="off" />
              </div>
            {/if}

            {#if server.transport === 'stdio'}
              <div class="mt-[12px] flex items-start justify-between gap-[8px] border-t border-[var(--border)] pt-[10px] text-[10px] text-[var(--muted-foreground)]">
                <div class="grid gap-[3px]">
                  <span>Environment variables</span>
                  <small class="text-[9px] leading-[1.35] text-[#6f6f6f]">Values are kept in VS Code SecretStorage and are not written to settings.</small>
                </div>
                <button class="btn h-[27px] w-[28px] p-0" data-variant="ghost" data-size="icon" type="button" aria-label="Add environment variable" title="Add environment variable" onclick={() => addMcpEnvironment(serverIndex)}>
                  <Plus size={13} strokeWidth={1.8} />
                </button>
              </div>
              {#if server.env.length > 0}
                <div class="mt-[7px] grid gap-[6px]">
                  {#each server.env as environment, environmentIndex (environmentIndex)}
                    <div class="grid grid-cols-[minmax(0,.9fr)_minmax(0,1.1fr)_24px] items-center gap-[5px] [@media(max-width:360px)]:grid-cols-[minmax(0,1fr)_24px]">
                      <input class={environmentInputClass} bind:value={environment.name} placeholder="ENVIRONMENT_NAME" aria-label="Environment variable name" autocomplete="off" />
                      <input class={`${environmentInputClass} [@media(max-width:360px)]:col-start-1`} type="password" bind:value={environment.value} placeholder={environment.configured ? 'Saved value — enter to replace' : 'Secret value'} aria-label="Environment variable value" autocomplete="new-password" />
                      <button class="btn h-[24px] w-[24px] p-0 [@media(max-width:360px)]:col-start-2 [@media(max-width:360px)]:row-span-2 [@media(max-width:360px)]:row-start-1" data-variant="ghost" data-size="icon" type="button" aria-label="Remove environment variable" title="Remove environment variable" onclick={() => removeMcpEnvironment(serverIndex, environmentIndex)}>
                        <X size={13} strokeWidth={1.8} />
                      </button>
                    </div>
                  {/each}
                </div>
              {/if}
            {:else}
              <small class="mt-[10px] block border-t border-[var(--border)] pt-[10px] text-[9px] leading-[1.35] text-[#747c84]">HTTP authentication headers are not configured in this editor yet.</small>
            {/if}
          </fieldset>
        {/each}
      </div>
    {/if}
  </section>
  <div class="mt-[2px] flex items-center justify-end gap-[8px]">
    <span></span>
    <button class="btn inline-flex items-center gap-[6px] border-0 bg-[var(--primary)] font-[650]! text-[var(--primary-foreground)]!" type="button" onclick={onSave} disabled={applying}>
      {#if applying}<LoaderCircle class="animate-spin motion-reduce:animate-none" size={13} strokeWidth={1.8} /> Applying…{:else}Save MCP servers <Check size={13} strokeWidth={1.8} />{/if}
    </button>
  </div>
</div>
