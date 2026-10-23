import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { Session } from './session-manager.js'

/** 会话持久化接口：让调用方通过统一的加载、保存方法读写会话，无需关心存储实现。 */
export interface SessionStore {
  /** 加载已保存的会话；没有历史记录时返回空数组。 */
  load(): Promise<Session[]>
  /** 将传入的会话列表作为完整快照保存，而不是逐条追加。 */
  save(sessions: Session[]): Promise<void>
}

/** 磁盘中单条会话的校验规则，防止格式不完整或字段不合法的数据进入内存。 */
const SessionSchema = z.object({
  // Agent OS 内部的会话唯一标识，不能为空。
  id: z.string().min(1),
  // 会话所属的飞书话题标识，不能为空。
  threadId: z.string().min(1),
  // 会话所属的飞书群聊标识，不能为空。
  chatId: z.string().min(1),
  // 执行会话的 CLI 类型，目前仅接受 Claude。
  cliId: z.literal('claude'),
  // AI 程序反馈的 session_id，目前仅接收 Claude 的
  cliSessionId: z.string().min(1).optional(),
  // 会话生命周期状态，只接受这里列出的四种值。
  status: z.enum(['creating', 'active', 'idle', 'closed']),
  // 会话创建时间，要求使用 ISO 日期时间字符串。
  createdAt: z.iso.datetime(),
  // 会话最近更新时间，要求使用 ISO 日期时间字符串。
  updatedAt: z.iso.datetime(),
})

/**
 * 恢复进程退出时尚未结束的会话：把 creating、active 改为 idle，以便后续接收追问。
 * 这里只恢复会话状态，不会重启 CLI 任务；其他状态的会话直接返回原对象。
 * @param session 从文件中读取并通过校验的会话。
 */
function recoverInterruptedSession(session: Session): Session {
  if (session.status !== 'creating' && session.status !== 'active')
    return session
  return { ...session, status: 'idle' }
}

/**
 * 使用 JSON 文件保存完整会话列表。
 * 加载时过滤无效记录并恢复中断状态，必要时将清理后的结果写回文件；
 * 保存时通过 Promise 队列串行写入，先写临时文件再重命名，避免直接覆盖目标文件时留下半截内容。
 */
export class JsonSessionStore implements SessionStore {
  /** 上一次保存操作的 Promise；后续保存接在它后面，避免同时写同一个临时文件。 */
  private writeQueue: Promise<void> = Promise.resolve()

  /**
   * 记录存储位置，实际目录和文件在保存时创建。
   * @param filePath 会话 JSON 文件路径，同时作为只读实例属性保存。
   */
  constructor(private readonly filePath: string) {}

  /**
   * 读取 JSON 数组，逐条校验并恢复会话，发现无效记录或中断状态时保存清理后的快照。
   * 文件不存在视为首次启动；读取失败、JSON 解析失败或顶层不是数组时向调用方抛错。
   */
  async load(): Promise<Session[]> {
    /** 从磁盘读取的原始 JSON 文本。 */
    let content: string
    try {
      content = await readFile(this.filePath, 'utf8')
    } catch (error) {
      // error 是读取文件时捕获的异常；只有文件不存在时可以安全地返回空列表。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }

    /** 解析后的原始数据，先标记为 unknown，检查数组结构后再逐条校验。 */
    const rows: unknown = JSON.parse(content)
    if (!Array.isArray(rows)) {
      throw new Error(`会话文件格式错误: ${this.filePath}`)
    }

    /** 最终返回的有效会话列表，其中中断的会话已恢复为空闲状态。 */
    const sessions: Session[] = []
    /** 是否丢弃过无效记录或恢复过状态，用于决定是否需要写回文件。 */
    let needsCleanup = false
    // row 是当前待校验的原始会话记录。
    for (const row of rows) {
      /** 单条记录的校验结果，成功时通过 data 获取符合会话结构的数据。 */
      const result = SessionSchema.safeParse(row)
      if (!result.success) {
        needsCleanup = true
        continue
      }

      /** 恢复中断状态后的会话；与原状态比较即可判断是否需要写回。 */
      const recovered = recoverInterruptedSession(result.data)
      if (recovered.status !== result.data.status) needsCleanup = true
      sessions.push(recovered)
    }
    if (needsCleanup) await this.save(sessions)
    return sessions
  }

  /**
   * 立即序列化当前会话快照，再排队执行文件写入，避免等待期间的数据变化影响本次保存。
   * 队列无论上次成功还是失败都会继续；本次写入失败仍会通过返回的 Promise 通知调用方。
   * @param sessions 本次需要完整保存的会话列表。
   */
  save(sessions: Session[]): Promise<void> {
    /** 调用 save 时生成的 JSON 快照，使用两个空格缩进，方便人工查看。 */
    const snapshot = JSON.stringify(sessions, null, 2)
    /** 本次排队执行的写入任务：确保目录存在，写临时文件，再替换正式文件。 */
    const write = async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      /** 与正式文件位于同一目录的临时文件路径，串行队列保证本实例不会并发写入它。 */
      const tempPath = `${this.filePath}.tmp`
      await writeFile(tempPath, `${snapshot}\n`, 'utf8')
      await rename(tempPath, this.filePath)
    }

    // 成功和失败分支都执行 write，避免前一次保存失败后阻塞所有后续保存。
    this.writeQueue = this.writeQueue.then(write, write)
    return this.writeQueue
  }
}
