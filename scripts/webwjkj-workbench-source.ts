/** Build-time admission of UI source files and rejection of executable IDE dependencies. */
const uiSource = /^vendor\/webwjkj\/vscode\/src\/vs\/(?:base\/(?:browser|common)\/|nls(?:\.messages)?\.ts$|webwjkj\/ui\.ts$)/
/**
 * Reject every dependency outside the cloned UI source directories.
 * @param inputs - esbuild's complete transitive input paths relative to the repository.
 * @param externals - unresolved imports retained in the emitted bundle.
 */
export function verifyWorkbenchSource(inputs: readonly string[], externals: readonly string[] = []): void {
  if (!inputs.length) throw new Error('Missing UI source graph')
  for (const file of inputs) if (!uiSource.test(file.replaceAll('\\', '/'))) throw new Error(`Non-UI dependency: ${file}`)
  if (externals.length) throw new Error(`External runtime dependency: ${externals.join(', ')}`)
}
