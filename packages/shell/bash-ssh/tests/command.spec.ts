import { describe, expect, it } from 'vitest'
import { remoteCommand, remoteWorkdir } from '../src/command.ts'
import { TailOutput } from '../src/output.ts'

const spec = { command: 'echo hello', workdir: '/remote', timeoutMs: 250, stdoutMaxBytes: 64, sandboxPolicy: undefined }

describe('SSH remote command and output', () => {
  it('uses remote SIGINT timeout only for foreground commands, without a kill-after fallback', () => {
    expect(remoteCommand(spec, true)).toContain('timeout --signal=INT 0.25s')
    expect(remoteCommand(spec, true)).not.toContain('kill-after')
    expect(remoteCommand(spec, false)).not.toContain('timeout ')
  })

  it('maps only paths within the local workspace and keeps remote absolute paths', () => {
    expect(remoteWorkdir(undefined, '/remote')).toBe('/remote')
    expect(remoteWorkdir('nested', '/remote')).toBe('/remote/nested')
    expect(remoteWorkdir('/local/project/nested', '/remote', '/local/project')).toBe('/remote/nested')
    expect(remoteWorkdir('/local/project-other', '/remote', '/local/project')).toBe('/local/project-other')
    expect(remoteWorkdir('/etc', '/remote', '/local/project')).toBe('/etc')
  })

  it('rejects shell-invalid environment names and NUL in command data', () => {
    expect(() => remoteCommand({ ...spec, env: { 'X; echo bad': 'value' } }, true)).toThrow('invalid environment variable name')
    expect(() => remoteCommand({ ...spec, command: 'echo\0bad' }, true)).toThrow('NUL')
  })

  it('bounds a single oversized chunk and reports consuming-read loss', () => {
    const output = new TailOutput(4)
    output.push(Buffer.from('abcdefgh'))
    expect(output.final()).toEqual({ text: 'efgh', truncated: true })
    expect(output.read(8)).toEqual({ text: '', lossy: false, offset: 8 })
    output.push(Buffer.from('ij'))
    expect(output.read(8)).toEqual({ text: 'ij', lossy: false, offset: 10 })
  })

  it('flushes an incomplete final UTF-8 character at stream close', () => {
    const output = new TailOutput(4)
    output.push(Buffer.from([0xe4, 0xbd]))
    output.seal()
    expect(output.final()).toEqual({ text: '\uFFFD', truncated: false })
  })

  it('preserves split UTF-8 chunks and omits partial characters clipped from the head', () => {
    const output = new TailOutput(4)
    const bytes = Buffer.from('你好')
    output.push(bytes.subarray(0, 2))
    expect(output.read(0).text).toBe('')
    output.push(bytes.subarray(2, 4))
    expect(output.read(0).text).toBe('你')
    output.push(bytes.subarray(4))
    expect(output.final()).toEqual({ text: '好', truncated: true })
  })
})
