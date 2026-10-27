import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  GEN_UI_ACTION_TEXT_LIMIT, GEN_UI_LIMITS, GEN_UI_TITLE_LIMIT, GEN_UI_TOOL_NAME,
  isInsideWorkspaces, parseGenUiCall, validateGenUiAction, validateGenUiSpec,
} from '../shared/gen-ui.js'
import {
  HELIX_GEN_UI_EXAMPLE_SPEC, HELIX_GEN_UI_PROP_HINTS, genUiPromptText, helixGenUiCatalog,
} from '../shared/gen-ui-catalog.js'
import { GEN_UI_TOOL_BUNDLE_ID, TOOL_BUNDLE_OPTIONS, toolBundlePatchLines } from '../shared/tool-bundles.js'

const card = {
  root: 'card',
  elements: {
    card: { type: 'Card', props: { title: 'Ship readiness' }, children: ['row', 'note'] },
    row: { type: 'Stack', props: { direction: 'horizontal' }, children: ['badge', 'go'] },
    badge: { type: 'Badge', props: { label: '2 failing', tone: 'danger' } },
    note: { type: 'Text', props: { text: 'Suite 4 of 6 green.', tone: 'muted' } },
    go: { type: 'Button', props: { label: 'Run the failing tests' }, on: { press: { action: 'prompt', params: { text: 'Run the two failing tests' } } } },
  },
  state: { failing: 2 },
}

test('a card spec passes, and a title is trimmed to a transcript-safe length', () => {
  const call = parseGenUiCall({ title: `  ${'Ship readiness'.repeat(40)}  `, spec: card })
  assert.equal(call.ok, true)
  if (!call.ok) return
  assert.equal(call.title?.length, GEN_UI_TITLE_LIMIT)
  assert.equal(call.spec.root, 'card')
})

test('a spec may arrive as a JSON string, which is how tool arguments often land', () => {
  assert.equal(parseGenUiCall(JSON.stringify({ spec: card })).ok, true)
  assert.equal(parseGenUiCall('not json').ok, false)
  assert.equal(parseGenUiCall(undefined).ok, false)
  assert.equal(parseGenUiCall({ spec: 'Card' }).ok, false)
  // A title is decoration. A model that sends a number still gets its card.
  const noTitle = parseGenUiCall({ title: 42, spec: card })
  assert.equal(noTitle.ok, true)
  assert.equal(noTitle.ok ? noTitle.title : 'x', undefined)
})

const rejected = [
  { root: 'a', elements: { a: { type: 'Marquee', props: {} } } },
  { root: 'a', elements: { a: { type: 'Badge', props: { label: 3 } } } },
  { root: 'a', elements: { a: { type: 'Badge', props: { label: 'x', extra: 'y' } } } },
  { root: 'a', elements: { a: { type: 'Badge', props: { label: 'x', action: { action: 'prompt' } } } } },
  { root: 'a', elements: { a: { type: 'Table', props: { columns: ['a', 'b'], rows: [['one']] } } } },
  { root: 'a', elements: { a: { type: 'Table', props: { columns: ['a'], rows: Array.from({ length: GEN_UI_LIMITS.maxTableRows + 1 }, () => ['x']) } } } },
  { root: 'a', elements: { a: { type: 'Button', props: { label: 'x' }, on: { press: { action: 'launchNuke', params: {} } } } } },
  { root: 'a', elements: { a: { type: 'Button', props: { label: 'x' }, on: { press: { action: 'prompt', params: { text: 3 } } } } } },
  { root: 'a', elements: { a: { type: 'Stack', props: {}, children: 'b' }, b: { type: 'Text', props: { text: 'x' } } } },
  { root: 'missing', elements: { a: { type: 'Text', props: { text: 'x' } } } },
  { root: 'a', elements: { a: { type: 'Grid', props: { columns: GEN_UI_LIMITS.maxGridColumns + 1 }, children: [] } } },
]

test('the catalog is the boundary: everything the renderer cannot draw is refused with a message the model can act on', () => {
  for (const spec of rejected) {
    const result = validateGenUiSpec(spec)
    assert.equal(result.ok, false, JSON.stringify(spec))
  }
  assert.match(validateGenUiSpec({ root: 'a', elements: { a: { type: 'Marquee', props: {} } } }).message ?? '', /not a Helix component/)
  assert.match(validateGenUiSpec(rejected[1]).message ?? '', /expected string/)
  assert.match(validateGenUiSpec(rejected[4]).message ?? '', /has 1 cells for 2 columns/)
  assert.match(validateGenUiSpec(rejected[6]).message ?? '', /launchNuke/)
  assert.match(validateGenUiSpec(rejected[rejected.length - 1]).message ?? '', /fits 3 columns/)
})

test('dynamic bindings are props too, so a card can read and write its own state', () => {
  const bound = {
    root: 'a',
    elements: {
      a: { type: 'Stack', props: {}, children: ['in', 'out', 'go'] },
      in: { type: 'TextInput', props: { label: 'Release note', value: { $bindState: '/form/note' } } },
      out: { type: 'Text', props: { text: { $template: 'Note: ${/form/note}' } } },
      go: { type: 'Button', props: { label: { $cond: { path: '/form/note', op: 'notEmpty' }, $then: 'Send', $else: 'Nothing to send' } }, on: { press: { action: 'prompt', params: { text: { $template: 'Note: ${/form/note}' } } } } },
    },
    state: { form: { note: '' } },
  }
  assert.equal(validateGenUiSpec(bound).ok, true)
  // Built-in json-render actions stay legal: they drive the card's own state.
  assert.equal(validateGenUiSpec({
    root: 'a', elements: { a: { type: 'Button', props: { label: 'x' }, on: { press: { action: 'setState', params: { path: '/open', value: true } } } } },
  }).ok, true)
})

test('the caps are enforced, and the message names the limit the spec ran into', () => {
  const tooMany = { root: 'a', elements: Object.fromEntries(Array.from({ length: GEN_UI_LIMITS.maxElements + 1 }, (_, i) => [`e${i}`, { type: 'Text', props: { text: 'x' } }])) }
  assert.match(validateGenUiSpec(tooMany).message ?? '', /elements/)
  const deep: Record<string, unknown> = { type: 'Text', props: { text: 'leaf' } }
  let node = deep
  for (let i = 0; i < GEN_UI_LIMITS.maxDepth + 3; i += 1) node = { type: 'Stack', props: {}, children: [node] }
  assert.equal(validateGenUiSpec({ root: 'root', elements: { root: node } }).ok, false)
  assert.match(validateGenUiSpec({ root: 'a', elements: { a: { type: 'Text', props: { text: 'y'.repeat(GEN_UI_LIMITS.maxPropTextCharacters + 1) } } } }).message ?? '', /characters/)
})

test('a card action is checked against the folders that are open, not against the card that asked', () => {
  const roots = ['/repo/project', 'C:\\repo\\project']
  const prompt = validateGenUiAction({ kind: 'prompt', text: 'Run the tests' }, roots)
  assert.equal(prompt.kind === 'prompt' && prompt.text, 'Run the tests')
  // Text can outlive the spec's own cap when a button reads it out of state at
  // click time, so the limit is enforced here too — and said out loud, not
  // quietly clipped into a message the user never chose.
  assert.throws(() => validateGenUiAction({ kind: 'prompt', text: 'x'.repeat(GEN_UI_ACTION_TEXT_LIMIT + 1) }, roots), /4000 characters/)
  assert.equal(validateGenUiAction({ kind: 'openLink', url: 'https://example.com/a' }, roots).kind, 'openLink')
  assert.equal(validateGenUiAction({ kind: 'openPath', path: '/repo/project/src/a.ts' }, roots).kind, 'openPath')
  assert.equal(validateGenUiAction({ kind: 'openPath', path: 'C:\\repo\\project\\src\\a.ts' }, roots).kind, 'openPath')
  for (const action of [
    {}, { kind: 'explode' }, { kind: 'prompt' }, { kind: 'prompt', text: '  ' },
    { kind: 'openLink', url: 'file:///etc/passwd' }, { kind: 'openLink', url: 'javascript:alert(1)' },
    { kind: 'openLink', url: 'not a url' },
    { kind: 'openPath', path: 'src/a.ts' }, { kind: 'openPath', path: '/etc/passwd' },
    { kind: 'openPath', path: '/repo/project/../secret' }, { kind: 'openPath', path: 'C:\\repo\\project\\..\\secret' },
  ]) {
    assert.throws(() => validateGenUiAction(action, roots), JSON.stringify(action))
  }
})

test('path containment resolves .. and does not care about Windows drive case', () => {
  assert.equal(isInsideWorkspaces('/repo/project/a', ['/repo/project']), true)
  assert.equal(isInsideWorkspaces('/repo/project/node_modules/../../secret', ['/repo/project']), false)
  assert.equal(isInsideWorkspaces('/repo/projects/a', ['/repo/project']), false)
  assert.equal(isInsideWorkspaces('c:\\repo\\project\\a', ['C:\\repo\\project']), true)
})

test('the prompt the model is given describes exactly the catalog the renderer can draw', () => {
  const components = helixGenUiCatalog.componentNames
  assert.deepEqual(Object.keys(HELIX_GEN_UI_PROP_HINTS).slice().sort(), components.slice().sort())
  const text = genUiPromptText()
  for (const name of components) assert.ok(text.includes(name), `${name} is not described to the model`)
  for (const name of helixGenUiCatalog.actionNames) assert.ok(text.includes(name), `${name} is not described to the model`)
  assert.ok(text.includes(GEN_UI_TOOL_NAME))
  assert.ok(text.includes('Never print it as prose'), 'the prompt must forbid printing the spec')
  // The card ends the turn; agents otherwise render one and then write the answer again.
  assert.ok(text.includes('is the response, not a prelude to one'), 'the prompt must say the card closes the turn')
  // A card shows data or collects input. Agents drift into writing the answer
  // inside one, so the prompt states the boundary and the budget that enforces it.
  assert.ok(text.includes('the shape of the answer, not the answer'), 'the prompt must say a card carries structure, not prose')
  assert.ok(text.includes('TEXT BUDGET:'), 'the prompt must give a text budget for a card')
  assert.ok(text.includes('NOT FOR:'), 'the prompt must say what a card is not for')
  assert.ok(text.length < 7_000, `the prompt section costs ${text.length} characters`)
})

test('the card tool is a Tools page toggle and is not a config patch line', () => {
  const bundle = TOOL_BUNDLE_OPTIONS.find((option) => option.id === GEN_UI_TOOL_BUNDLE_ID)
  assert.equal(bundle?.tools.join(','), GEN_UI_TOOL_NAME)
  assert.equal(toolBundlePatchLines([]).some((line) => line.includes(GEN_UI_TOOL_BUNDLE_ID)), false)
  assert.equal(toolBundlePatchLines([GEN_UI_TOOL_BUNDLE_ID]).some((line) => line.includes(GEN_UI_TOOL_BUNDLE_ID)), false)
})

/**
 * The renderer hands every element an `emit`, and an `on` binding fires only
 * when the component calls it. Nothing in the catalog records which components
 * do, so the Svelte source is the record and the test reads it.
 */
const COMPONENTS_DIR = new URL('../../src/webview/lib/gen-ui/components/', import.meta.url)

function componentSource(name: string): string {
  return readFileSync(new URL(`${name}.svelte`, COMPONENTS_DIR), 'utf8')
}

/** Component types whose implementation calls the `emit` the renderer hands it. */
function emittingComponentTypes(): Set<string> {
  return new Set(helixGenUiCatalog.componentNames.filter((name) => /\bemit\s*\(/.test(componentSource(name))))
}

function catalogDescription(name: string): string {
  const components = helixGenUiCatalog.data.components as Record<string, { description?: string }>
  return `${components[name]?.description ?? ''} ${HELIX_GEN_UI_PROP_HINTS[name] ?? ''}`
}

test('every catalog component has a Svelte implementation wired into the registry', () => {
  const registry = readFileSync(new URL('../../src/webview/lib/gen-ui/registry.ts', import.meta.url), 'utf8')
  for (const name of helixGenUiCatalog.componentNames) {
    assert.ok(componentSource(name).length > 0, `${name}.svelte is empty`)
    assert.match(registry, new RegExp(`import ${name} from '\\./components/${name}\\.svelte'`), `${name} is not wired into the registry`)
  }
})

test('the example the model copies is a valid spec, and every on in it fires', () => {
  assert.equal(validateGenUiSpec(HELIX_GEN_UI_EXAMPLE_SPEC).ok, true)
  const emitting = emittingComponentTypes()
  const elements = HELIX_GEN_UI_EXAMPLE_SPEC.elements as Record<string, { type: string; on?: unknown }>
  const bound = Object.entries(elements).filter(([, element]) => element.on !== undefined)
  assert.ok(bound.length > 0, 'the example must show at least one event binding')
  for (const [key, element] of bound) {
    const event = Object.keys(element.on as object)[0]
    assert.ok(emitting.has(element.type), `the example binds on.${event} on a ${element.type}, which never calls emit`)
  }
  // A container is a surface, not a control. This is the bug the example had.
  assert.equal(bound.every(([, element]) => element.type === 'Button'), true)
  assert.ok(!emitting.has('Card'), 'Card fires no events, so it must never carry an on binding')
})

test('the shipped prompt carries that example, and shows no binding that cannot fire', () => {
  const text = genUiPromptText()
  const elements = HELIX_GEN_UI_EXAMPLE_SPEC.elements as Record<string, { on?: unknown }>
  for (const element of Object.values(elements)) {
    assert.ok(text.includes(JSON.stringify(element)), `the prompt does not show ${JSON.stringify(element)}`)
  }
  const emitting = emittingComponentTypes()
  for (const name of helixGenUiCatalog.componentNames) {
    if (emitting.has(name)) continue
    assert.ok(!new RegExp(`"type":\\s*"${name}"[^\\n]*"on"\\s*:`).test(text), `the prompt shows an on binding on ${name}, which cannot fire`)
  }
})

test('a component described to the model as firing an event fires it', () => {
  const emitting = emittingComponentTypes()
  const claiming = helixGenUiCatalog.componentNames.filter((name) => /\bon\.\w+/.test(catalogDescription(name)))
  assert.deepEqual(claiming, ['Button'], 'the prompt advertises events on unexpected components')
  for (const name of claiming) {
    assert.ok(emitting.has(name), `${name} is described as firing an event and never calls emit`)
  }
})
