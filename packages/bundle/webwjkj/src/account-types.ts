/** Browser-facing account data; authentication tokens never enter this view. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** UUID identifying one webwjkj user, independent of Harness Session identities. */
export type UserId = Branded<'WebwjkjUserId'>

/** Verified login identity and editable profile fields. */
export interface AccountUser {
  /** Server-generated UUID. */
  id: UserId
  /** Display username. */
  name: string
  /** Unique normalized username for password login, when configured. */
  loginName: string | null
  /** Whether credential login has been configured. */
  hasPassword: boolean
  /** Verified phone number in E.164 form. */
  phone: string
  /** Verified optional email, never the internal phone-signup placeholder. */
  email: string | null
  /** Optional HTTPS avatar URL. */
  image: string | null
  /** Whether one WeChat identity is linked. */
  wechat: boolean
}
