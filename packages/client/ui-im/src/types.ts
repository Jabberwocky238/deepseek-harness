/** IM panel request and response fields shared by the host and browser. */

import type { Conversation, ImMessage, Participant } from '@deepseek-ai/dsh-im/types'

/** The local human's platform-isolated navigation and inbox. */
export interface ImPanelSnapshot {
  viewer: Participant
  contacts: Participant[]
  conversations: Conversation[]
  inbox: ImMessage[]
  people: Participant[]
  attachmentLimits: { maxBytes: number; maxCount: number }
  pollIntervalMs: number
}
/** Uploaded attachment bytes; references are minted by the host after validation. */
export interface ImUpload {
  kind: 'file' | 'image'
  name: string
  data: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'application/octet-stream'
}
/** Membership-checked binary content for image display or a file download. */
export interface ImDownload { name: string; mediaType: string; data: string }
