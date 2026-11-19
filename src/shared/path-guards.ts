/**
 * Path shape rules shared by every plane.
 *
 * The Host enforces the workspace rules, and the Webview needs the same
 * absolute-path test to decide whether a path it was handed can be opened at
 * all, so the test lives here rather than inside one feature's module.
 */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path)
}
