import assert from 'node:assert/strict'
import test from 'node:test'
import {
  commandLine,
  commandLineHtml,
  commandPopupOpen,
  completeCommand,
  filterCommands,
  isCommandCatalog,
  parseCommandInvocation,
  resolveCommandToken,
  slashTrigger,
  type ComposerCommand,
} from '../shared/commands.js'

const command = (name: string, description: string, hint?: string): ComposerCommand =>
  hint === undefined ? { name, description } : { name, description, hint }

const named = (name: string): ComposerCommand => catalog.find((entry) => entry.name === name)!

const catalog: ComposerCommand[] = [
  command('compact', 'Compact older conversation history'),
  command('goal', 'Create, pause, resume, or complete the session goal', '[action]'),
  command('plan', 'Enter or leave plan mode', '[off|message]'),
  command('permissions', 'Change the permission preset'),
  command('review-diff', 'Review the current diff', '[focus]'),
  command('feedback', 'Send feedback about this session'),
]

test('a command line resolves with the Host name grammar', () => {
  assert.deepEqual(parseCommandInvocation('/compact'), { name: 'compact', args: '' })
  assert.deepEqual(parseCommandInvocation('/plan off'), { name: 'plan', args: 'off' })
  assert.deepEqual(parseCommandInvocation('/goal  resume '), { name: 'goal', args: 'resume' })
  assert.deepEqual(parseCommandInvocation('/review-diff src/webview'), { name: 'review-diff', args: 'src/webview' })
  assert.equal(parseCommandInvocation('compact'), undefined, 'the slash is required')
  assert.equal(parseCommandInvocation('/Compact'), undefined, 'names are lowercase')
  assert.deepEqual(parseCommandInvocation('/compaction'), { name: 'compaction', args: '' }, 'the name runs to the end of the line, so an unknown command is simply not in the catalog')
  assert.deepEqual(parseCommandInvocation('/compact the history'), { name: 'compact', args: 'the history' }, 'text after the name is the argument payload')
  assert.equal(parseCommandInvocation('  /compact'), undefined, 'the command must start the line')
  assert.equal(commandLine('plan', 'off'), '/plan off')
  assert.equal(commandLine('compact', ''), '/compact')
})

test('the transcript line paints the command token gold and escapes the arguments', () => {
  assert.equal(
    commandLineHtml('plan', 'build a parser'),
    '<span class="text-[var(--brand-gold)]">/plan</span> build a parser',
  )
  assert.equal(commandLineHtml('compact', ''), '<span class="text-[var(--brand-gold)]">/compact</span>')
  assert.equal(
    commandLineHtml('feedback', 'a <script> & "quote"'),
    '<span class="text-[var(--brand-gold)]">/feedback</span> a &lt;script&gt; &amp; &quot;quote&quot;',
    'the arguments are text, never markup',
  )
})

test('the trigger follows the caret through the name and closes on the arguments', () => {
  assert.deepEqual(slashTrigger('/', 1), { start: 0, end: 1, query: '' })
  assert.deepEqual(slashTrigger('/comp', 5), { start: 0, end: 5, query: 'comp' })
  assert.deepEqual(slashTrigger('/compact', 3), { start: 0, end: 8, query: 'compact' })
  assert.equal(slashTrigger('/compact the history', 12), undefined, 'the caret is naming arguments, not a command')
  assert.equal(slashTrigger('/compact', 0), undefined, 'the caret before the slash is not naming it')
  assert.equal(slashTrigger('ask about /compact', 14), undefined, 'a slash mid-sentence is not a command')
})

test('the popup is filtered by the typed query with the best match first', () => {
  assert.deepEqual(filterCommands(catalog, '').map((entry) => entry.name), [
    'compact', 'feedback', 'goal', 'permissions', 'plan', 'review-diff',
  ], 'an empty query lists the catalog in name order')
  assert.equal(filterCommands(catalog, 'comp')[0]?.name, 'compact')
  assert.equal(filterCommands(catalog, 'compact')[0]?.name, 'compact', 'an exact name wins')
  assert.deepEqual(filterCommands([...catalog, command('plan-mode', 'Toggle a plan')], 'plan').map((entry) => entry.name),
    ['plan', 'plan-mode'], 'an exact name outranks a name that merely starts with the query')
  assert.deepEqual(filterCommands(catalog, 'rev').map((entry) => entry.name), ['review-diff'], 'a name segment counts as a word start')
  assert.deepEqual(filterCommands(catalog, 'vd').map((entry) => entry.name), ['review-diff'], 'letters in order are enough')
  assert.deepEqual(filterCommands(catalog, 'fee').map((entry) => entry.name), ['feedback'], 'a substring match still surfaces')
  assert.deepEqual(filterCommands(catalog, 'permission').map((entry) => entry.name), ['permissions'])
  assert.equal(filterCommands(catalog, 'zzz').length, 0)
  assert.deepEqual(filterCommands(catalog, 'plan mode').map((entry) => entry.name), ['plan'], 'a description match is a last resort')
})

test('description matches rank behind name matches', () => {
  const ranked = filterCommands([command('compact', 'Review the current diff'), command('review', 'Review the diff')], 'review')
  assert.deepEqual(ranked.map((entry) => entry.name), ['review', 'compact'], 'a name match outranks a description match')
})

test('a resolved command token is the gold span in the composer', () => {
  assert.equal(resolveCommandToken('/compact', catalog)?.command.name, 'compact')
  assert.equal(resolveCommandToken('/compact src', catalog)?.command.name, 'compact')
  assert.equal(resolveCommandToken('/comp', catalog), undefined, 'a partial name is not yet a command')
  assert.equal(resolveCommandToken('/nope', catalog), undefined, 'an unknown name is not a command')
  assert.equal(resolveCommandToken('plan the release', catalog), undefined)
  assert.equal(resolveCommandToken('/compact', catalog)?.end, 8)
})

test('completing a command leaves a resolved token and a caret ready for arguments', () => {
  assert.deepEqual(completeCommand('/comp', 5, named('compact')), { text: '/compact', caret: 8 })
  assert.deepEqual(completeCommand('/comp', 5, named('goal')), { text: '/goal ', caret: 6 }, 'a command with arguments gets the space')
  assert.deepEqual(completeCommand('/comp arg', 5, named('goal')), { text: '/goal arg', caret: 6 }, 'arguments already typed survive the completion')
  assert.deepEqual(completeCommand('/comp arg', 5, named('compact')), { text: '/compact arg', caret: 9 })
  assert.deepEqual(completeCommand('/', 1, named('compact')), { text: '/compact', caret: 8 })
})

test('accepting a listed row shuts the popup', () => {
  const typed: Array<[string, number]> = [['/', 1], ['/comp', 5], ['/compact', 8], ['/compact arg', 8]]
  for (const [text, caret] of typed) {
    const rows = filterCommands(catalog, slashTrigger(text, caret)?.query ?? '')
    assert.ok(rows.length > 0, `typing "${text}" lists rows`)
    for (const command of rows) {
      const completed = completeCommand(text, caret, command)
      assert.equal(commandPopupOpen(completed.text, completed.caret, command.name), false,
        `picking /${command.name} from "${text}" closes the popup`)
    }
  }
})

test('the popup follows the token under the caret, not the row that was accepted', () => {
  assert.equal(commandPopupOpen('/comp', 5, undefined), true)
  assert.equal(commandPopupOpen('/goal ', 6, 'goal'), false, 'the caret is past the token the completion left')
  assert.equal(commandPopupOpen('/compact', 8, 'compact'), false, 'the completed name does not reopen the popup')
  assert.equal(commandPopupOpen('/compactx', 9, 'compact'), true, 'naming a new token lists again')
  assert.equal(commandPopupOpen('/compact arg', 12, 'compact'), false, 'the caret is naming arguments')
  assert.equal(commandPopupOpen('ask about /compact', 16, undefined), false, 'a slash mid-sentence is not a command')
})

test('catalog payloads from the Host are validated', () => {
  assert.equal(isCommandCatalog({ available: true, commands: [] }), true)
  assert.equal(isCommandCatalog({ available: true, commands: [command('compact', 'x')] }), true)
  assert.equal(isCommandCatalog({ available: true, commands: [{ name: 'Bad Name', description: 'x' }] }), false)
  assert.equal(isCommandCatalog({ available: true, commands: [{ name: 'ok', description: 1 }] }), false)
  assert.equal(isCommandCatalog({ commands: [] }), false)
  assert.equal(isCommandCatalog(null), false)
})
