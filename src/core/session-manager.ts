import { randomUUID } from 'node:crypto'
import type { CliId } from '../cli/types.js'
import type { SessionStore } from './session-store.js'

export type SessionStatus = 'creating' | 'active' | 'idle' | 'closed'

export interface Session {
  id: string // Agent OS 自己的会话 ID，通过 Node.js 的 randomUUID() 生成
  botId: string
  threadId: string // 飞书的话题群 id
  chatId: string // 话题群内的话题 id
  cliId: CliId // 记录以后交给哪个执行引擎，比如 Claude Code 或者 Codex
  cliSessionId?: string // Claude Code 的 session_id
  workspaceDir: string // 工作路径
  status: SessionStatus
  createdAt: string
  updatedAt: string
}

export interface MessageAddress {
  messageId: string
  chatId: string
  threadId: string
  rootId: string
}

export interface ResolvedSession {
  session: Session
  isNew: boolean
}

export interface SessionManagerOptions {
  now?: () => Date
  createId?: () => string
  store?: SessionStore
}

/**
 * creating：刚从消息创建，还没开始执行；
 * active：任务正在运行；
 * idle：上一轮已经结束，可以接收追问；
 * closed：会话明确结束，同一话题不再接任务。
 */
const ALLOWED_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  creating: ['active', 'idle', 'closed'],
  active: ['idle', 'closed'],
  idle: ['active', 'closed'],
  closed: [],
}

function topicIdOf(message: MessageAddress): string {
  return message.threadId || message.rootId || message.messageId
}

function sessionKey(botId: string, chatId: string, threadId: string): string {
  return `${botId}:${chatId}:${threadId}`
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>()
  private readonly now: () => Date
  private readonly createId: () => string
  private readonly store?: SessionStore

  constructor(options: SessionManagerOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? randomUUID
    this.store = options.store
  }

  static async open(
    options: SessionManagerOptions = {},
  ): Promise<SessionManager> {
    const manager = new SessionManager(options)
    const restored = (await options.store?.load()) ?? []
    for (const session of restored) {
      manager.sessions.set(
        sessionKey(session.botId, session.chatId, session.threadId),
        session,
      )
    }
    return manager
  }

  private async persist(): Promise<void> {
    await this.store?.save([...this.sessions.values()])
  }

  get size(): number {
    return this.sessions.size
  }

  get(sessionId: string): Session | undefined {
    return [...this.sessions.values()].find(
      (session) => session.id === sessionId,
    )
  }

  async resolve(
    message: MessageAddress,
    cliId: CliId = 'codex',
    botId = 'default',
    workspaceDir = process.cwd(),
  ): Promise<ResolvedSession> {
    const threadId = topicIdOf(message)
    const key = sessionKey(botId, message.chatId, threadId)
    const existing = this.sessions.get(key)
    if (existing) return { session: existing, isNew: false }

    const now = this.now().toISOString()
    const session: Session = {
      id: this.createId(),
      botId,
      threadId,
      chatId: message.chatId,
      cliId: cliId,
      workspaceDir,
      status: 'creating',
      createdAt: now,
      updatedAt: now,
    }
    this.sessions.set(key, session)

    try {
      await this.persist()
    } catch (error) {
      if (this.sessions.get(key) === session) this.sessions.delete(key)
      throw error
    }

    return { session, isNew: true }
  }

  async transition(
    sessionId: string,
    nextStatus: SessionStatus,
  ): Promise<Session> {
    const current = this.get(sessionId)
    if (!current) throw new Error(`会话不存在: ${sessionId}`)
    if (!ALLOWED_TRANSITIONS[current.status].includes(nextStatus)) {
      throw new Error(`会话 ${current.status} 不能切换到 ${nextStatus}`)
    }

    const updated: Session = {
      ...current,
      status: nextStatus,
      updatedAt: this.now().toISOString(),
    }
    const key = sessionKey(updated.botId, updated.chatId, updated.threadId)
    this.sessions.set(key, updated)
    try {
      await this.persist()
    } catch (error) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current)
      throw error
    }
    return updated
  }

  async setCliSessionId(
    sessionId: string,
    cliSessionId: string,
  ): Promise<Session> {
    const current = this.get(sessionId)
    if (!current) throw new Error(`会话不存在: ${sessionId}`)
    if (!cliSessionId) throw new Error('CLI 会话 ID 不能为空')

    const updated: Session = {
      ...current,
      cliSessionId,
      updatedAt: this.now().toISOString(),
    }
    const key = sessionKey(updated.botId, updated.chatId, updated.threadId)
    this.sessions.set(key, updated)

    try {
      await this.persist()
    } catch (error) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current)
      throw error
    }

    return updated
  }

  async setWorkspaceDir(
    sessionId: string,
    workspaceDir: string,
  ): Promise<Session> {
    const current = this.get(sessionId)
    if (!current) throw new Error(`会话不存在: ${sessionId}`)
    if (!workspaceDir) throw new Error('工作目录不能为空')
    if (current.workspaceDir === workspaceDir) return current

    const { cliSessionId: _previousCliSessionId, ...rest } = current
    // 剔除掉 cliSessionId，这样 codex 和 claude 就会创建新的会话
    const updated: Session = {
      ...rest,
      workspaceDir,
      updatedAt: this.now().toISOString(),
    }
    const key = sessionKey(updated.botId, updated.chatId, updated.threadId)
    this.sessions.set(key, updated)
    try {
      await this.persist()
    } catch (error) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current)
      throw error
    }
    return updated
  }
}
