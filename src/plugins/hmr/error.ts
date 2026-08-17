import { Context } from '../../core/index.ts'
import { codeFrameColumns } from '@babel/code-frame'
import { readFileSync } from 'node:fs'

/**
 * The part of an esbuild `BuildFailure` this reporter reads. Declared here so
 * a type-only import does not pull esbuild's native binary into installs.
 */
interface BuildFailure {
  errors: {
    text: string
    location: { file: string, line: number, column: number } | null
  }[]
}

function isBuildFailure(e: any): e is BuildFailure {
  return Array.isArray(e?.errors) && e.errors.every((error: any) => error.text)
}

/** Log HMR build failures with code frames when source locations are available. */
export function handleError(ctx: Context, e: any) {
  if (!isBuildFailure(e)) {
    ctx.logger.warn(e)
    return
  }

  for (const error of e.errors) {
    if (!error.location) {
      ctx.logger.warn(error.text)
      continue
    }
    try {
      const { file, line, column } = error.location
      const source = readFileSync(file, 'utf8')
      const formatted = codeFrameColumns(source, {
        start: { line, column },
      }, {
        highlightCode: true,
        message: error.text,
      })
      ctx.logger.warn(`File: ${file}:${line}:${column}\n` + formatted)
    } catch (e) {
      ctx.logger.warn(e)
    }
  }
}
