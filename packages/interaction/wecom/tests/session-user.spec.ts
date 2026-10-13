import { describe, expect, it } from 'vitest'
import { sessionIdentity } from '../src/session-user.ts'

// The login derivation is a contract: the deployment's rollout reimplements it
// to place each conversation's files in its home before the plugin runs. These
// golden values lock that derivation, so any change here is caught and the
// other implementation can be checked against it.
describe('conversation login derivation', () => {
  it('derives a single conversation as u_single_<hash8>', () => {
    const key = JSON.stringify(['single', null, 'alice'])
    expect(sessionIdentity('test-bot', key, '/home', 'dsh-test')).toEqual({
      user: 'u_single_68f8c40c',
      home: '/home/u_single_68f8c40c',
      alias: 'dsh-test-single_68f8c40c',
    })
  })

  it('derives a group conversation as u_group_<hash8>', () => {
    const key = JSON.stringify(['group', 'g123', 'bob'])
    expect(sessionIdentity('test-bot', key, '/home', 'dsh-test')).toEqual({
      user: 'u_group_8cddacd2',
      home: '/home/u_group_8cddacd2',
      alias: 'dsh-test-group_8cddacd2',
    })
  })

  it('is stable: the same conversation recomputes the same identity', () => {
    const key = JSON.stringify(['single', null, 'alice'])
    const first = sessionIdentity('test-bot', key, '/home', 'dsh-test')
    const second = sessionIdentity('test-bot', key, '/home', 'dsh-test')
    expect(second).toEqual(first)
  })

  it('keeps distinct members of the same bot apart', () => {
    const alice = sessionIdentity('test-bot', JSON.stringify(['single', null, 'alice']), '/home', 'dsh-test')
    const carol = sessionIdentity('test-bot', JSON.stringify(['single', null, 'carol']), '/home', 'dsh-test')
    expect(carol.user).not.toBe(alice.user)
    expect(carol.home).not.toBe(alice.home)
  })
})
