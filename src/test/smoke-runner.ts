/// <reference lib="dom" />
// Runs the VS Code Extension Development Host smoke suites in order.
// Invoked by the "Helix: Run Smoke Tests" command in a development host;
// never imported by the Node test suite.
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as vscode from 'vscode'
import { run as runBrowserSmoke } from './browser-vscode-smoke.js'
import { run as runQuestionSmoke } from './question-vscode-smoke.js'
import { run as runSkillsSmoke } from './skills-vscode-smoke.js'
import { run as runSubagentSmoke } from './subagent-vscode-smoke.js'

export interface SmokeSuiteResult {
  name: string
  passed: boolean
  durationMs: number
  error?: string
}

const SUITES: Array<{ name: string; run: () => Promise<void> }> = [
  { name: 'question', run: runQuestionSmoke },
  { name: 'subagent', run: runSubagentSmoke },
  { name: 'skills', run: runSkillsSmoke },
  { name: 'browser', run: runBrowserSmoke },
]

export async function runSmokeTests(channel: vscode.OutputChannel): Promise<SmokeSuiteResult[]> {
  const results: SmokeSuiteResult[] = []
  for (const suite of SUITES) {
    channel.show()
    channel.appendLine(`[smoke] ${suite.name}: running…`)
    const started = Date.now()
    try {
      await suite.run()
      const result: SmokeSuiteResult = { name: suite.name, passed: true, durationMs: Date.now() - started }
      results.push(result)
      channel.appendLine(`[smoke] ${suite.name}: passed in ${result.durationMs}ms`)
    } catch (error) {
      const result: SmokeSuiteResult = { name: suite.name, passed: false, durationMs: Date.now() - started, error: String(error) }
      results.push(result)
      channel.appendLine(`[smoke] ${suite.name}: FAILED after ${result.durationMs}ms — ${result.error}`)
    }
  }

  const file = join(tmpdir(), 'helix-smoke-results.json')
  writeFileSync(file, JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2))
  const failed = results.filter((result) => !result.passed)
  if (failed.length === 0) {
    channel.appendLine(`[smoke] all ${results.length} suites passed (results: ${file})`)
    vscode.window.showInformationMessage(`Helix smoke: all ${results.length} suites passed`)
  } else {
    channel.appendLine(`[smoke] ${failed.length}/${results.length} suites failed (results: ${file})`)
    vscode.window.showErrorMessage(`Helix smoke: ${failed.map((result) => result.name).join(', ')} failed — see the Helix Smoke Tests output channel`)
  }
  return results
}
