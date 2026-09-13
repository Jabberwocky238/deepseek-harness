/**
 * Disk source with non-following listings and atomic JSON metadata replacement.
 * @module @deepseek-ai/dsh-data-lake/disk
 */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { METADATA, lakePath } from './records.ts'
import type { LakeEntry, LakeSource } from './types.ts'

/** Disk provider; source symlinks are indexed without traversal. */
export class DiskLakeSource implements LakeSource {
  constructor(private readonly root: string) {}

  private async directory(path: string): Promise<string> {
    lakePath(path)
    const base = await realpath(this.root)
    const target = await realpath(resolve(base, path))
    const delta = relative(base, target)
    if (delta === '..' || delta.startsWith(`..${sep}`) || isAbsolute(delta)) {
      throw new Error('data-lake: directory escapes the configured root')
    }
    return target
  }

  async list(directory: string, signal: AbortSignal): Promise<readonly LakeEntry[]> {
    signal.throwIfAborted()
    const target = await this.directory(directory)
    const entries: LakeEntry[] = []
    for (const name of await readdir(target)) {
      signal.throwIfAborted()
      if (name === METADATA) continue
      const stat = await lstat(join(target, name))
      const kind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other'
      entries.push({
        path: lakePath(`${directory}${name}${kind === 'directory' ? '/' : ''}`), name, kind,
        bytes: kind === 'file' ? stat.size : 0,
        ...(kind === 'directory' ? {} : { modifiedAt: stat.mtime.toISOString() }),
      })
    }
    return entries
  }

  private async metadataPath(path: string, create: boolean): Promise<string> {
    const marker = `${METADATA}/`
    const at = path.indexOf(marker)
    if (at < 0) throw new Error('data-lake: writes require a metadata path')
    const parent = await this.directory(path.slice(0, at))
    const suffix = path.slice(at + marker.length)
    if (!/^(index\.json|(?:maps|summaries)\/[a-f0-9]{64}\.json)$/.test(suffix)) {
      throw new Error('data-lake: invalid metadata location')
    }
    const target = join(parent, METADATA, suffix)
    if (create) await mkdir(dirname(target), { recursive: true })
    // Metadata directories are owned by this provider, never followed through links.
    for (const component of [join(parent, METADATA), dirname(target), target]) {
      try {
        if ((await lstat(component)).isSymbolicLink()) throw new Error('data-lake: metadata path is a symlink')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return target
  }

  async read(path: string, signal: AbortSignal): Promise<unknown> {
    try {
      return JSON.parse(await readFile(await this.metadataPath(path, false), { encoding: 'utf8', signal })) as unknown
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async write(path: string, value: unknown, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const target = await this.metadataPath(path, true)
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600, signal })
      signal.throwIfAborted()
      await rename(temporary, target)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
