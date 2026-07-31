/**
 * Load artifact file contents from the workspace via Jan's filesystem bridge.
 */
export async function readArtifactFileContent(path: string): Promise<string> {
  const { fs } = await import('@janhq/core')
  const raw = await fs.readFileSync(path)
  if (typeof raw === 'string') return raw
  if (raw == null) return ''
  return String(raw)
}
