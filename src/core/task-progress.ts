/**
 * 任务进度记录模块：接收 CLI 适配器解析出的 CliEvent，累计工具调用与上下文信息，
 * 再生成供卡片渲染的 TaskProgressSnapshot。事件处理、进度统计与卡片展示由此分离。
 */
import type { CliEvent } from '../cli/types.js'

/** 一条已结束的工具调用记录，用于卡片的历史列表 */
export interface TaskActivity {
  /** 工具原始名，如 Read、Bash */
  toolName: string
  /** 展示用的中文短标签，如「读取文件」 */
  label: string
  /** 补充细节，如文件路径、命令描述；无内容时可省略 */
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
  /** 当前工具的细节；无内容时省略 */
  currentDetail?: string
  /** 从创建跟踪器到生成本次快照经过的时间（毫秒） */
  elapsedMs: number
  /** 累计收到的 tool_start 事件数 */
  toolCount: number
  /** 已成功配对的 tool_end 事件数，包含成功与失败的调用 */
  completedCount: number
  /** 最近完成的调用记录，最多 12 条，新的在前 */
  activities: TaskActivity[]
  /** 运行中统计的上下文占用 token；未收到 context 事件时缺省 */
  contextUsedTokens?: number
  /** 本轮首次收到 context 事件时的上下文占用量；不一定是任务启动瞬间的值 */
  contextStartTokens?: number
  /** 模型上下文窗口大小，由构造参数传入；未知时缺省 */
  contextWindowTokens?: number
  /** 本轮是否开启新会话；跟踪器仅在构造参数为 true 时输出该字段，否则省略 */
  startedNewSession?: boolean
}

/** 正在执行中的工具调用状态，仅在模块内部使用，供开始与结束事件配对及计算耗时。 */
interface ActiveTool {
  /** 工具原始名 */
  toolName: string
  /** 展示用中文短标签 */
  label: string
  /** 细节描述，如文件路径 */
  detail?: string
  /** 收到 tool_start 时的毫秒时间戳，用于在 tool_end 时计算耗时 */
  startedAt: number
}

/**
 * 汇总一轮任务的运行进度，供日志和飞书卡片读取。
 * accept 按事件类型更新内部状态，用 toolUseId 配对工具调用，保留最近 12 条结束记录；
 * snapshot 根据当前状态生成展示快照。跟踪器本身不执行 CLI、不发送卡片，也不判断任务最终成败。
 */
export class TaskProgressTracker {
  /** 创建跟踪器时的毫秒时间戳，作为整轮任务计时的起点。 */
  private readonly startedAt: number
  /** 执行中的工具调用表，以 toolUseId 为键，支持同时记录多个调用。 */
  private readonly activeTools = new Map<string, ActiveTool>()
  /** 最近结束的工具调用记录，新的放在数组头部，最多保留 12 条。 */
  private readonly activities: TaskActivity[] = []
  /** 累计收到的工具开始事件数，不受历史记录条数上限影响。 */
  private toolCount = 0
  /** 已找到对应开始记录的工具结束次数，成功和失败都会计入。 */
  private completedCount = 0
  /** 最近一次 context 事件报告的上下文占用量；收到事件前为 undefined。 */
  private contextUsedTokens: number | undefined
  /** 首次 context 事件报告的占用量，保存后不再随后续事件变化。 */
  private contextStartTokens: number | undefined

  /**
   * 初始化一轮任务的计时及会话展示信息，工具列表和计数使用字段的初始值。
   * @param now 返回毫秒时间戳的时钟函数，默认 Date.now；可注入可控时钟以验证耗时计算。
   * @param contextWindowTokens 模型上下文窗口容量，仅用于快照展示，不在此计算或推断。
   * @param startedNewSession 本轮是否新建 CLI 会话，由调用方根据会话状态传入，默认 false。
   */
  constructor(
    /** 读取当前毫秒时间的函数，用于计算任务总耗时和单次工具耗时。 */
    private readonly now: () => number = Date.now,
    /** 调用方提供的上下文窗口容量；未知时保持 undefined。 */
    private readonly contextWindowTokens?: number,
    /** 调用方提供的新会话标记，整个跟踪周期内保持不变。 */
    private readonly startedNewSession = false,
  ) {
    this.startedAt = now()
  }

  /**
   * 接收一个 CLI 事件，更新统计后返回最新快照。
   * context 更新 token 占用量，tool_start 登记调用，tool_end 结束对应调用并记录耗时；
   * 其他事件不改变统计，仅返回当前快照。找不到开始记录的 tool_end 会被忽略。
   * @param event CLI 适配器已解析好的结构化事件。
   * @returns 更新后的进度快照，可直接交给卡片构建函数。
   */
  accept(event: CliEvent): TaskProgressSnapshot {
    if (event.type === 'context') {
      // ??= 仅在尚未记录起始占用量时赋值，0 也是有效值，不会被后续事件覆盖。
      this.contextStartTokens ??= event.usedTokens
      this.contextUsedTokens = event.usedTokens
    }
    if (event.type === 'tool_start') {
      this.toolCount += 1
      // 用调用 ID 而非工具名配对，同一种工具的不同调用可以分别追踪。
      this.activeTools.set(event.toolUseId, {
        toolName: event.toolName,
        label: event.label,
        detail: event.detail,
        startedAt: this.now(),
      })
    }
    if (event.type === 'tool_end') {
      /** 与结束事件 ID 对应的开始记录；不存在时无法计算耗时，也不增加结束计数。 */
      const tool = this.activeTools.get(event.toolUseId)
      if (tool) {
        // 先移除执行中记录，重复收到同一结束事件时便不会重复计数。
        this.activeTools.delete(event.toolUseId)
        this.completedCount += 1
        // 将结束记录放到最前面；Math.max 防止时钟回拨导致负耗时。
        this.activities.unshift({
          toolName: tool.toolName,
          label: tool.label,
          ...(tool.detail ? { detail: tool.detail } : {}),
          durationMs: Math.max(0, this.now() - tool.startedAt),
          failed: event.failed,
        })
        // 删除下标 12 及之后的记录，控制卡片历史列表长度，但保留累计计数。
        this.activities.splice(12)
      }
    }
    return this.snapshot()
  }

  /**
   * 从当前内部状态生成一份进度快照，不修改计数和工具记录。
   * 优先展示最后加入且仍在执行的工具；没有执行中的工具时，根据是否调用过工具选择兜底文案。
   * 每次调用都会重新计算总耗时，因此即使没有新事件，定时读取也能让卡片的计时继续更新。
   * @returns 新的快照对象，未知或不适用的可选字段会被省略。
   */
  snapshot(): TaskProgressSnapshot {
    /** Map 按插入顺序遍历，取最后一个仍在执行的调用作为当前展示动作。 */
    const active = [...this.activeTools.values()].at(-1)
    return {
      // 没有运行中的工具不代表任务已结束，仍可能处于模型分析阶段。
      current:
        active?.label ?? (this.toolCount ? '正在分析执行结果' : '正在理解任务'),
      // 条件展开仅在有对应信息时加入字段，避免给卡片传入无意义的可选值。
      ...(active ? { currentToolName: active.toolName } : {}),
      ...(active?.detail ? { currentDetail: active.detail } : {}),
      elapsedMs: Math.max(0, this.now() - this.startedAt),
      toolCount: this.toolCount,
      completedCount: this.completedCount,
      // 浅拷贝列表，避免调用方增删快照数组时影响内部历史；其中的记录对象仍共享引用。
      activities: [...this.activities],
      // 显式判断 undefined，确保 0 token 也能正常出现在快照中。
      ...(this.contextUsedTokens !== undefined
        ? { contextUsedTokens: this.contextUsedTokens }
        : {}),
      ...(this.contextStartTokens !== undefined
        ? { contextStartTokens: this.contextStartTokens }
        : {}),
      ...(this.contextWindowTokens !== undefined
        ? { contextWindowTokens: this.contextWindowTokens }
        : {}),
      ...(this.startedNewSession ? { startedNewSession: true } : {}),
    }
  }
}
