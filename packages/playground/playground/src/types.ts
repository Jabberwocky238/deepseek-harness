/** Docker container identities and SSH connection metadata. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Full Docker id of a container owned by a Playground namespace. */
export type PlaygroundContainerId = Branded<'PlaygroundContainerId'>

/** Inputs for creating a stopped container from an existing image. */
export interface CreateContainerRequest {
  /** Image already available to the Docker daemon; no image is selected or pulled implicitly. */
  image: string
  /** Optional Docker name; Docker rejects duplicates. */
  name?: string
  /** TCP port on which the image's SSH server listens. */
  sshPort: number
  /** Existing SSH account; Playground does not create accounts or install credentials. */
  username: string
  /** Optional argv replacing the image CMD, with its ENTRYPOINT preserved. */
  command?: string[]
  /** Explicit image environment; the Harness process environment is never copied. */
  env?: Record<string, string>
}

/** Published SSH destination; does not assert server readiness or successful authentication. */
export interface SshEndpoint {
  /** Configured address of the Docker host reachable by the caller. */
  host: string
  /** Docker-assigned published TCP port. */
  port: number
  /** Image account supplied during creation. */
  username: string
}

/** Fresh Docker observation, without image environment or authentication material. */
export interface PlaygroundContainer {
  /** Canonical immutable Docker id, used for all subsequent mutations. */
  id: PlaygroundContainerId
  /** Docker name without its leading slash. */
  name: string
  /** Image reference recorded in the container configuration. */
  image: string
  /** Docker's reported state, including states unknown to this build. */
  status: string
  /** Container-side SSH listener port recorded at creation. */
  sshPort: number
  /** Existing SSH account recorded at creation. */
  username: string
  /** Published destination while running; null when Docker reports no running endpoint. */
  ssh: SshEndpoint | null
}
