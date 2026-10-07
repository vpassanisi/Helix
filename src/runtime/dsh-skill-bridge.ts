import { createHash } from 'node:crypto'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import { isSkillOverrides, type SkillCatalog, type SkillTurnSelection } from '../shared/skills.js'

interface TurnState {
  selection: SkillTurnSelection
  active: Map<string, any>
  excluded: Set<string>
  prepared: boolean
  serial: number
  loading: Map<string, Promise<any>>
}

/** Uses the live DSH registry and each agent's own scoped tool layer. */
export class DshSkillBridge {
  private readonly turns = new Map<string, TurnState>()
  private readonly installed = new Map<string, { agent: any; dispose: () => void }>()
  private serial = 0
  private readonly staging = new Map<string, number>()
  constructor(private readonly ctx: any, private readonly cwd: string) {}
  private get registry(): any { return this.ctx.get?.('skills') ?? this.ctx.skills }
  private agent(sessionId: string): any { return (this.ctx.get?.('agents') ?? this.ctx.agents)?.get?.(sessionId) }
  private lookup(agent?: any, signal?: AbortSignal): any {
    return { cwd: agent?.session?.header?.cwd ?? this.cwd, ...(agent ? { scope: agent } : {}), ...(signal ? { signal } : {}) }
  }
  async catalog(sessionId: string): Promise<SkillCatalog> {
    if (!this.registry) throw new Error('The DSH skill registry is unavailable.')
    const snapshot = await this.registry.snapshot(this.lookup(this.agent(sessionId)))
    const skills = snapshot.skills.map((skill: any) => ({ name: skill.name, description: skill.description,
      ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}), modelInvocable: skill.invocation.modelInvocable,
      userInvocable: skill.invocation.userInvocable }))
    return { skills, complete: snapshot.complete, revision: createHash('sha256').update(JSON.stringify(skills)).digest('hex') }
  }
  async stage(sessionId: string, value: unknown): Promise<void> {
    if (!isSkillOverrides(value) || typeof (value as SkillTurnSelection).prompt !== 'string') throw new Error('Invalid skill selection.')
    const selection = value as SkillTurnSelection
    const state: TurnState = { selection: { ...selection, include: [...new Set(selection.include)], exclude: [...new Set(selection.exclude)] },
      active: new Map(), excluded: new Set(selection.exclude), prepared: false, serial: ++this.serial, loading: new Map() }
    this.staging.set(sessionId, state.serial)
    const agent = this.agent(sessionId)
    // Preflight makes missing/manual-disabled selections a submission error, not a silent omission.
    for (const name of state.selection.include) {
      if (state.excluded.has(name)) continue
      const skill = await this.registry?.get(name, this.lookup(agent))
      if (!skill || !(selection.manual?.includes(name) ? skill.invocation.userInvocable : skill.invocation.modelInvocable)) throw new Error(`Skill "${name}" is no longer available for this invocation.`)
      state.active.set(name, skill)
    }
    if (this.staging.get(sessionId) !== state.serial) throw new Error('Skill selection was cancelled.')
    this.turns.set(sessionId, state)
    if (agent) this.install(agent)
  }
  clear(sessionId: string): void { this.turns.delete(sessionId); this.staging.delete(sessionId) }
  created = ({ agent }: any): void => { if (this.turns.has(agent.id)) this.install(agent) }
  disposed = ({ agent }: any): void => {
    this.clear(agent.id)
    this.installed.get(agent.id)?.dispose()
    this.installed.delete(agent.id)
  }
  private install(agent: any): void {
    if (this.installed.get(agent.id)?.agent === agent) return
    const tools = agent.ctx?.tools
    const original = tools?.get('skill', agent)
    if (!original) return
    const dispose = tools.register({ ...original,
      execute: async (args: any, exec: any) => {
        const state = this.turns.get(agent.id)
        if (!state) return original.execute(args, exec)
        if (state.excluded.has(args.name)) throw new Error(`Skill "${args.name}" was excluded by the user for this turn.`)
        const existing = state.active.get(args.name)
        if (existing) return { name: existing.name, provider: existing.provider, content: 'These instructions are already provided in the current Helix skills snapshot. Do not reload them.' }
        const pending = state.loading.get(args.name)
        if (pending) {
          await pending
          exec.signal?.throwIfAborted()
          return { name: args.name, provider: state.active.get(args.name)?.provider ?? 'helix', content: 'These instructions were already provided by another skill call in this turn.' }
        }
        const loading = (async () => {
          const result = await original.execute(args, exec)
          const skill = await this.registry.get(args.name, this.lookup(agent, exec.signal))
          if (this.turns.get(agent.id) === state && skill) state.active.set(args.name, skill)
          return result
        })()
        state.loading.set(args.name, loading)
        try { return await loading } finally { state.loading.delete(args.name) }
      },
    })
    this.installed.set(agent.id, { agent, dispose })
  }
  assemble = async (assembly: any, context: any, next: () => Promise<any>): Promise<any> => {
    const assembled = await next()
    const agent = context.agent ?? context.scope
    const state = this.turns.get(agent?.id)
    if (!state) return assembled
    this.install(agent)
    const snapshot = await this.registry.snapshot(this.lookup(agent, context.signal))
    if (!snapshot.complete) throw new Error('Skill discovery is incomplete. Retry the message.')
    if (!state.prepared) {
      // Resolve again with the actual agent scope, including its preset providers.
      const names = new Set([...state.selection.include, ...state.active.keys()])
      const explicitNames = new Set(state.selection.manual ?? [])
      for (const match of state.selection.prompt.matchAll(/(?:^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g)) {
        const skill = await this.registry.get(match[1], this.lookup(agent, context.signal))
        if (skill?.invocation.userInvocable) { names.add(skill.name); explicitNames.add(skill.name) }
      }
      const active = new Map<string, any>()
      for (const name of names) {
        if (state.excluded.has(name)) continue
        const skill = await this.registry.get(name, this.lookup(agent, context.signal))
        const explicit = explicitNames.has(name)
        if (!skill || !(explicit ? skill.invocation.userInvocable : skill.invocation.modelInvocable)) throw new Error(`Skill "${name}" is no longer available for this invocation.`)
        active.set(name, skill)
      }
      state.active = active
      state.prepared = true
    }
    if (this.turns.get(agent.id) !== state) throw new Error('Skill selection changed before the model request.')
    const remaining = snapshot.skills.filter((skill: any) => skill.invocation.modelInvocable && !state.active.has(skill.name) && !state.excluded.has(skill.name))
    const text = [
      `Current Helix skills snapshot (selection ${state.serial}). This replaces all earlier Helix skill snapshots and available-skill catalogs. Earlier skill instructions are historical, not active, unless included here or loaded in this turn.`,
      'Follow the active instructions below. They are already loaded; do not call the skill tool for them. Referenced resources may still be read as needed.',
      ...[...state.active.values()].map((skill) => renderSkillContent(skill)),
      `Excluded this turn: ${[...state.excluded].join(', ') || 'none'}. Do not load or apply excluded skills.`,
      'Remaining loadable skills (summaries only; use the skill tool before applying them):',
      ...remaining.map((skill: any) => `- ${skill.name}: ${skill.description}`),
    ].join('\n\n')
    return { ...assembled, variables: { ...assembled.variables, helix_skills_context: text },
      contexts: [...assembled.contexts.filter((entry: any) => entry.name !== 'helix:skills'), { name: 'helix:skills', text: '{{helix_skills_context}}' }] }
  }
  preStep = async (payload: any, next: () => Promise<any>): Promise<any> => {
    const decision = await next()
    const state = this.turns.get(payload.agent.id)
    if (!state || decision.kind === 'reject') return decision
    // Stock /skill injections use the same canonical body; our snapshot already carries it.
    return { ...decision, messages: decision.messages.filter((message: any) =>
      message.source?.kind !== 'skill-catalog' && !(message.source?.kind === 'skill-invocation' &&
        (state.active.has(message.source.name) || state.excluded.has(message.source.name)))) }
  }
  dispose(): void {
    for (const entry of this.installed.values()) entry.dispose()
    this.installed.clear(); this.turns.clear(); this.staging.clear()
  }
}
