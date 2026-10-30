/**
 * 接收解析出的 CliEvent，记录当前正在做什么、完成了哪些工具调用、运行了多久，并返回一份供卡片渲染的 TaskProgressSnapshot
 */
import type { CliEvent } from '../cli/types.js'

/** 一条已结束的工具调用记录，用于卡片的历史列表 */
export interface TaskActivity {
  /** 工具原始名，如 Read、Bash */
  toolName: string
  /** 展示用的中文短标签，如「读取文件」 */
  label: string
  /** 补充细节，如文件路径、命令描述；无则为空 */
  detail?: string
  /** 这次调用从开始到结束的耗时（毫秒） */
  durationMs: number
  /** 是否以失败结束 */
  failed: boolean
}

/** 某一时刻的进度快照，卡片按它渲染即可，不关心事件过程 */
export interface TaskProgressSnapshot {
  /** 当前动作文案，如「读取文件」「正在分析执行结果」 */
  current: string
  /** 当前正在执行的工具名；空闲时缺省 */
  currentToolName?: string
  /** 当前工具的细节；无则为空 */
  currentDetail?: string
  /** 任务从开始到现在经过的时间（毫秒） */
  elapsedMs: number
  /** 累计发起的工具调用数 */
  toolCount: number
  /** 已经结束的工具调用数 */
  completedCount: number
  /** 最近完成的调用记录，最多 12 条，新的在前 */
  activities: TaskActivity[]
  /** 运行中统计的上下文占用 token；未收到 context 事件时缺省 */
  contextUsedTokens?: number
  /** 模型上下文窗口大小，由构造参数传入；未知时缺省 */
  contextWindowTokens?: number
}

/** 正在执行中的工具调用的内部状态，配对外面不可见 */
interface ActiveTool {
  /** 工具原始名 */
  toolName: string
  /** 展示用中文短标签 */
  label: string
  /** 细节描述，如文件路径 */
  detail?: string
  /** 开始时间戳，用于在 tool_end 时算耗时 */
  startedAt: number
}
export class TaskProgressTracker {
  private readonly startedAt: number
  private readonly activeTools = new Map<string, ActiveTool>()
  private readonly activities: TaskActivity[] = []
  private toolCount = 0
  private completedCount = 0
  private contextUsedTokens: number | undefined

  constructor(
    private readonly now: () => number = Date.now,
    private readonly contextWindowTokens?: number,
  ) {
    this.startedAt = now()
  }

  accept(event: CliEvent): TaskProgressSnapshot {
    if (event.type === 'context') {
      this.contextUsedTokens = event.usedTokens
    }
    if (event.type === 'tool_start') {
      this.toolCount += 1
      this.activeTools.set(event.toolUseId, {
        toolName: event.toolName,
        label: event.label,
        detail: event.detail,
        startedAt: this.now(),
      })
    }
    if (event.type === 'tool_end') {
      const tool = this.activeTools.get(event.toolUseId)
      if (tool) {
        this.activeTools.delete(event.toolUseId)
        this.completedCount += 1
        this.activities.unshift({
          toolName: tool.toolName,
          label: tool.label,
          ...(tool.detail ? { detail: tool.detail } : {}),
          durationMs: Math.max(0, this.now() - tool.startedAt),
          failed: event.failed,
        })
        this.activities.splice(12)
      }
    }
    return this.snapshot()
  }

  snapshot(): TaskProgressSnapshot {
    const active = [...this.activeTools.values()].at(-1)
    return {
      current:
        active?.label ?? (this.toolCount ? '正在分析执行结果' : '正在理解任务'),
      ...(active ? { currentToolName: active.toolName } : {}),
      ...(active?.detail ? { currentDetail: active.detail } : {}),
      elapsedMs: Math.max(0, this.now() - this.startedAt),
      toolCount: this.toolCount,
      completedCount: this.completedCount,
      activities: [...this.activities],
      ...(this.contextUsedTokens !== undefined
        ? { contextUsedTokens: this.contextUsedTokens }
        : {}),
      ...(this.contextWindowTokens !== undefined
        ? { contextWindowTokens: this.contextWindowTokens }
        : {}),
    }
  }
}
