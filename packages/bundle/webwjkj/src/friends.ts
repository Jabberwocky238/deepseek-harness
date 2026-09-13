/** Durable friend applications; only their recipient can accept or reject them. */
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { UserId } from './account-types.ts'

const profileSchema = z.object({ id: z.uuid(), name: z.string(), image: z.string().nullable() })
const requestSchema = z.object({ id: z.uuid(), sender: z.uuid(), recipient: z.uuid(), greeting: z.string(), status: z.enum(['pending', 'accepted', 'rejected']), name: z.string(), image: z.string().nullable() })
/** Public profile, without phone numbers, email addresses, or login credentials. */
export type FriendProfile = z.infer<typeof profileSchema>
/** Application input validated at the HTTP and database entry. */
export const friendInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('search'), query: z.string().trim().min(1).max(254) }),
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('request'), target: z.uuid(), greeting: z.string().trim().max(500) }),
  z.object({ action: z.enum(['accept', 'reject']), requestId: z.uuid() }),
])
/**
 * Read accepted peers for the idempotent IM contact projection.
 * @param db - account database under its runtime lock.
 * @param owner - authenticated UUID.
 * @returns accepted public profiles only.
 */
export function acceptedFriends(db: DatabaseSync, owner: UserId): FriendProfile[] {
  return z.array(profileSchema).parse(db.prepare('SELECT DISTINCT u.id,u.name,u.image FROM wjkj_friend_requests r JOIN user u ON u.id=CASE WHEN r.sender=? THEN r.recipient ELSE r.sender END WHERE (r.sender=? OR r.recipient=?) AND r.status=\'accepted\'').all(owner, owner, owner))
}
/**
 * Execute a friend operation under the account runtime's cross-process lock.
 * @param db - migrated account database.
 * @param owner - authenticated UUID, never selected by browser input.
 * @param input - bounded search or application operation.
 * @returns a public profile or the caller's application list.
 */
export function friendOperation(db: DatabaseSync, owner: UserId, input: z.infer<typeof friendInput>): unknown {
  if (input.action === 'search') {
    const query = input.query
    const phone = query.replace(/[\s-]/g, '')
    const row = db.prepare('SELECT id,name,image FROM user WHERE id<>? AND (id=? OR (phoneNumber=? AND phoneNumberVerified=1) OR (lower(email)=? AND emailVerified=1)) LIMIT 1').get(owner, query.toLowerCase(), phone.startsWith('+') ? phone : `+86${phone}`, query.toLowerCase())
    return { profile: row ? profileSchema.parse(row) : null }
  }
  if (input.action === 'request') {
    if (input.target === owner || !db.prepare('SELECT id FROM user WHERE id=?').get(input.target)) throw new Error('Invalid friend target')
    const existing = db.prepare('SELECT id,status FROM wjkj_friend_requests WHERE (sender=? AND recipient=?) OR (sender=? AND recipient=?)').get(owner, input.target, input.target, owner)
    if (!existing) db.prepare('INSERT INTO wjkj_friend_requests (id,sender,recipient,greeting,status,updatedAt) VALUES (?,?,?,?,\'pending\',?)').run(randomUUID(), owner, input.target, input.greeting, Date.now())
    else if (existing['status'] === 'rejected') db.prepare('UPDATE wjkj_friend_requests SET sender=?,recipient=?,greeting=?,status=\'pending\',updatedAt=? WHERE id=?').run(owner, input.target, input.greeting, Date.now(), String(existing['id']))
  }
  if (input.action === 'accept' || input.action === 'reject') {
    const row = db.prepare('SELECT recipient,status FROM wjkj_friend_requests WHERE id=?').get(input.requestId)
    if (!row || row['recipient'] !== owner) throw new Error('Friend application is not addressed to this account')
    if (row['status'] === 'pending') db.prepare('UPDATE wjkj_friend_requests SET status=?,updatedAt=? WHERE id=?').run(input.action === 'accept' ? 'accepted' : 'rejected', Date.now(), input.requestId)
  }
  return { requests: z.array(requestSchema).parse(db.prepare('SELECT r.id,r.sender,r.recipient,r.greeting,r.status,u.name,u.image FROM wjkj_friend_requests r JOIN user u ON u.id=CASE WHEN r.sender=? THEN r.recipient ELSE r.sender END WHERE r.sender=? OR r.recipient=? ORDER BY r.updatedAt DESC,r.id LIMIT 100').all(owner, owner, owner)) }
}
