/**
 * 飞书任务卡片的展示层：接收调用方整理好的进度快照、回答和统计信息，
 * 按任务状态生成飞书卡片 JSON；不直接解析 CLI 事件，也不直接请求飞书接口。
 * 末尾的更新器通过注入的异步函数，把高频进度合并为定时、串行的卡片提交。
 */
import type { CliRunStats } from '../cli/types.js'
import type {
  TaskActivity,
  TaskProgressSnapshot,
} from '../core/task-progress.js'

/** 卡片 JSON 的通用对象类型；具体结构由构建函数组装，不提供完整的 schema 校验。 */
export type CardJson = Record<string, unknown>
/** 卡片展示的任务状态，决定标题颜色及正文分支。 */
export type TaskStatus = 'running' | 'success' | 'failed' | 'cancelled'

/** 构建一张完整任务卡片所需的数据；可选字段缺失时省略对应展示或使用兜底文案。 */
export interface TaskCardOptions {
  /** 卡片标题，例如「Claude Code 任务」。 */
  title: string
  /** 当前任务状态；只有 running 使用运行中正文，其余使用结束正文。 */
  status: TaskStatus
  /** 状态说明，同时作为缺少当前动作或最终回答时的兜底文本。 */
  detail: string
  /** 已由 TaskProgressTracker 等调用方整理好的进度快照，不是百分比。 */
  progress?: TaskProgressSnapshot
  /** 成功时的最终回答；过长时先摘要、再折叠，并提示调用方续发。 */
  answer?: string
  /** CLI 返回的耗时和 token 统计，用于结束卡片的执行详情。 */
  stats?: CliRunStats
  /** 失败或取消时可折叠查看的技术细节。 */
  technicalDetail?: string
  /** 成功卡片底部要 @ 的接收者飞书 open_id。 */
  recipientOpenId?: string
  /** 停止按钮回调携带的会话标识；真正中止任务需由外部回调处理器完成。 */
  abortSessionId?: string
}

/** 各状态对应的飞书标题主题色与中文标签；as const 保留字面量类型。 */
const STATUS_STYLE = {
  running: { template: 'blue', label: '执行中' },
  success: { template: 'green', label: '已完成' },
  failed: { template: 'red', label: '执行失败' },
  cancelled: { template: 'grey', label: '已取消' },
} as const

/** 回答直接展示的长度阈值，也是折叠回答摘要的截取长度。 */
const COMPACT_ANSWER_LENGTH = 900
/** 本项目给卡片内回答设置的截取长度；不是飞书整张卡片的大小限制。 */
const MAX_CARD_ANSWER_LENGTH = 6_000
/** 运行中最多展示的最近完成工具记录数。 */
const RUNNING_ACTIVITY_LIMIT = 3
/** 任务结束后，执行详情中最多展示的工具记录数。 */
const FINISHED_ACTIVITY_LIMIT = 8

/** 工具原始名称到展示图标的映射；未命中的工具在使用处回退为齿轮图标。 */
const TOOL_ICONS: Record<string, string> = {
  Agent: '🧩',
  Bash: '⌘',
  Edit: '✏️',
  Glob: '📁',
  Grep: '🔎',
  Read: '📄',
  Task: '🧩',
  TaskOutput: '⏳',
  WebFetch: '🌐',
  WebSearch: '🔍',
  Write: '📝',
}

/** 将 durationMs 毫秒四舍五入成至少一秒，再按秒或分秒生成可读耗时。 */
function formatDuration(durationMs: number): string {
  /** 换算后的总秒数；很短的任务也显示为一秒。 */
  const totalSeconds = Math.max(1, Math.round(durationMs / 1_000))
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  /** 完整分钟数。 */
  const minutes = Math.floor(totalSeconds / 60)
  /** 扣除完整分钟后剩余的秒数。 */
  const seconds = totalSeconds % 60
  if (seconds === 0) return `${minutes} 分钟`
  return `${minutes} 分 ${seconds} 秒`
}

/** 将数值 value 格式化：不足一千保留原值，否则用 k 表示并四舍五入到一位小数。 */
function formatCount(value: number): string {
  return value >= 1_000 ? `${Math.round(value / 100) / 10}k` : String(value)
}

/** 替换 value 中的反引号，避免路径或错误文本提前结束外层的行内代码标记。 */
function escapeInlineCode(value: string): string {
  return value.replaceAll('`', 'ˋ')
}

/** 在 value 中疑似 HTML 标签的左尖括号后插入零宽连接符实体，减少飞书标签误解析。 */
function escapeFeishuMarkdown(value: string): string {
  return value.replace(/<(?=\/?[A-Za-z][^>]*>)/g, '<&zwj;')
}

/** 将一条已完成的 activity 记录拼为「图标 + 标签 + 可选细节 + 可选耗时」。 */
function activityLine(activity: TaskActivity): string {
  /** 失败记录优先用警告图标，否则按工具名选择。 */
  const icon = activity.failed ? '⚠️' : (TOOL_ICONS[activity.toolName] ?? '⚙️')
  /** 可选工具细节；用行内代码突出路径、命令等文本。 */
  const detail = activity.detail
    ? ` · \`${escapeInlineCode(activity.detail)}\``
    : ''
  /** 仅在耗时达到一秒时追加耗时，减少短调用的展示噪音。 */
  const duration =
    activity.durationMs >= 1_000
      ? ` · ${formatDuration(activity.durationMs)}`
      : ''
  return `${icon} ${activity.label}${detail}${duration}`
}

/**
 * 为 text 查找不超过 maxLength 的切点：优先段落，其次换行，最后按长度硬切。
 * 自然切点需达到目标长度的 55%，避免为了完整段落而只保留很短的内容。
 */
function markdownSplitIndex(text: string, maxLength: number): number {
  if (text.length <= maxLength) return text.length
  /** 长度上限以内最后一个段落分隔符的位置。 */
  const paragraph = text.lastIndexOf('\n\n', maxLength)
  if (paragraph >= maxLength * 0.55) return paragraph
  /** 没有合适段落时尝试的最后一个换行位置。 */
  const line = text.lastIndexOf('\n', maxLength)
  return line >= maxLength * 0.55 ? line : maxLength
}

/** 对 markdown 中行首的三反引号做奇偶计数；若截断后未闭合，则补一个结束围栏。 */
function closeOpenFence(markdown: string): string {
  /** 简单统计代码围栏数量，不是完整的 Markdown 语法解析。 */
  const fences = markdown.match(/^```/gm)?.length ?? 0
  return fences % 2 === 1 ? `${markdown}\n\n\`\`\`` : markdown
}

/** 截取 text 的前 maxLength 附近内容、去除首尾空白并补齐代码围栏；补齐后可能略超长度。 */
function markdownPreview(text: string, maxLength: number): string {
  return closeOpenFence(
    text.slice(0, markdownSplitIndex(text, maxLength)).trim(),
  )
}

/** 为 answer 生成短摘要：尽量取首个换行代码块前的文字，截短后清理末尾孤立标题或分隔线。 */
function compactAnswerPreview(answer: string): string {
  /** 第一个「换行 + 三反引号」的位置；开头直接出现的代码围栏不由此规则排除。 */
  const fenceIndex = answer.search(/\n```/)
  /** 优先用于摘要的代码块前正文；没有匹配时使用整个回答。 */
  const prose = fenceIndex > 0 ? answer.slice(0, fenceIndex) : answer
  /** 清理后的摘要；不足 40 字符时返回提示文案，引导用户展开。 */
  const preview = markdownPreview(prose, COMPACT_ANSWER_LENGTH)
    .replace(/\n(?:---|#{1,6}\s+[^\n]+)\s*$/, '')
    .trim()
  return preview.length >= 40
    ? preview
    : '回答包含较多代码与细节，展开后可以查看完整内容。'
}

/** 优先读取 stats 的总 token 数；缺失时累加已有分项，全部缺失则不展示消耗。 */
function usageTotal(stats: CliRunStats | undefined): number | undefined {
  if (!stats) return undefined
  if (stats.totalTokens !== undefined) return stats.totalTokens
  /** 过滤 undefined 后的统计分项；类型谓词把数组元素收窄为 number，保留有效的零值。 */
  const values = [
    stats.inputTokens,
    stats.outputTokens,
    stats.cacheReadTokens,
    stats.cacheCreationTokens,
  ].filter((value): value is number => value !== undefined)
  return values.length
    ? values.reduce((sum, value) => sum + value, 0)
    : undefined
}

/** 根据 usedTokens 和 windowTokens 生成上下文占用文案；窗口未知时只展示用量，异常超限时省略。 */
function formatContextUsage(
  usedTokens: number | undefined,
  windowTokens: number | undefined,
): string | undefined {
  if (usedTokens === undefined) return undefined
  if (windowTokens === undefined || windowTokens <= 0) {
    return `当前上下文约 ${formatCount(usedTokens)} tokens`
  }
  if (usedTokens > windowTokens) return undefined
  /** 当前占用相对窗口容量的整数百分比。 */
  const percentage = Math.round((usedTokens / windowTokens) * 100)
  return `当前上下文 ${formatCount(usedTokens)} / ${formatCount(windowTokens)}（${percentage}%）`
}

/** 比较当前 usedTokens 与本轮起点 startTokens；按 startedNewSession 选择起点标签，支持占用减少。 */
function formatContextGrowth(
  usedTokens: number | undefined,
  startTokens: number | undefined,
  startedNewSession = false,
): string | undefined {
  if (usedTokens === undefined || startTokens === undefined) return undefined
  /** 本轮上下文净变化量；它与累计 token 消耗不是同一个指标。 */
  const delta = usedTokens - startTokens
  /** 带方向的变化文案。 */
  const change =
    delta >= 0
      ? `新增 ${formatCount(delta)}`
      : `减少 ${formatCount(Math.abs(delta))}`
  /** 区分新会话基础占用与续接会话的本轮起始占用。 */
  const startLabel = startedNewSession ? '新会话基础' : '本轮开始'
  return `${startLabel} ${formatCount(startTokens)} · ${change}`
}

/** 根据 options 依次组装当前动作、运行统计、最近完成记录和可选的停止按钮。 */
function buildRunningElements(
  options: TaskCardOptions,
): Record<string, unknown>[] {
  /** 当前进度快照；尚无快照时使用 detail 和「刚刚开始」兜底。 */
  const progress = options.progress
  /** 当前工具对应的图标前缀；没有工具时不展示。 */
  const currentIcon = progress?.currentToolName
    ? `${TOOL_ICONS[progress.currentToolName] ?? '⚙️'} `
    : ''
  /** 当前动作的补充细节，另起一行展示。 */
  const currentDetail = progress?.currentDetail
    ? `\n\`${escapeInlineCode(progress.currentDetail)}\``
    : ''
  /** 已耗时间和累计发起的工具调用数。 */
  const meta = progress
    ? `${formatDuration(progress.elapsedMs)} · ${progress.toolCount} 次工具调用`
    : '刚刚开始'
  /** 可选的当前上下文用量文案。 */
  const context = formatContextUsage(
    progress?.contextUsedTokens,
    progress?.contextWindowTokens,
  )
  /** 可选的本轮上下文净变化文案。 */
  const contextGrowth = formatContextGrowth(
    progress?.contextUsedTokens,
    progress?.contextStartTokens,
    progress?.startedNewSession,
  )
  /** 按展示顺序收集的卡片正文组件。 */
  const elements: Record<string, unknown>[] = [
    {
      tag: 'markdown',
      content: `**${currentIcon}${progress?.current ?? options.detail}**${currentDetail}\n\n${meta}${context ? `\n_${context}_` : ''}${contextGrowth ? `\n_${contextGrowth}_` : ''}`,
    },
  ]
  if (progress?.activities.length) {
    /** 快照中的记录已按新到旧排列，运行中只取前三条。 */
    const visible = progress.activities.slice(0, RUNNING_ACTIVITY_LIMIT)
    elements.push({
      tag: 'markdown',
      content: `**最近完成（${visible.length} / ${progress.completedCount}）**\n${visible.map(activityLine).join('\n')}`,
    })
  }
  if (options.abortSessionId) {
    // 此处只声明回调载荷，不直接停止 CLI；外部需处理 abort_task 动作。
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '停止任务' },
      type: 'danger',
      width: 'default',
      size: 'medium',
      behaviors: [
        {
          type: 'callback',
          value: {
            action: 'abort_task',
            sessionId: options.abortSessionId,
          },
        },
      ],
    })
  }
  return elements
}

/**
 * 根据 options 组装结束卡片：成功展示回答，失败或取消展示说明及可选错误详情；
 * 随后追加折叠的统计与执行轨迹，成功时还可在底部 @ 接收者。
 */
function buildFinishedElements(
  options: TaskCardOptions,
): Record<string, unknown>[] {
  /** 最后一份进度快照，用于工具轨迹、调用次数和上下文变化。 */
  const progress = options.progress
  /** 耗时优先使用 CLI 最终统计，缺失时回退到快照记录的经过时间。 */
  const durationMs = options.stats?.durationMs ?? progress?.elapsedMs
  /** 累计 token 消耗；未知时不展示。 */
  const totalTokens = usageTotal(options.stats)
  /** 用量优先取快照，窗口容量优先取最终统计，再分别回退到另一个来源。 */
  const context = formatContextUsage(
    progress?.contextUsedTokens ?? options.stats?.contextUsedTokens,
    options.stats?.contextWindowTokens ?? progress?.contextWindowTokens,
  )
  /** 对比当前占用与快照中的本轮起点；缺少起点时无法计算。 */
  const contextGrowth = formatContextGrowth(
    progress?.contextUsedTokens ?? options.stats?.contextUsedTokens,
    progress?.contextStartTokens,
    progress?.startedNewSession,
  )
  /** 耗时和工具调用数，过滤缺失项后在同一行展示。 */
  const executionMeta = [
    durationMs !== undefined
      ? `**耗时** ${formatDuration(durationMs)}`
      : undefined,
    progress ? `**工具调用** ${progress.toolCount} 次` : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
  /** 累计消耗、当前占用和本轮变化，过滤缺失项后分行展示。 */
  const usageMeta = [
    totalTokens !== undefined
      ? `**累计消耗** ${formatCount(totalTokens)} tokens`
      : undefined,
    context
      ? `**当前上下文** ${context.replace(/^当前上下文(?:约)?\s+/, '')}`
      : undefined,
    contextGrowth ? `**本轮变化** ${contextGrowth}` : undefined,
  ]
    .filter(Boolean)
    .join('\n')
  /** 合并执行统计与用量统计，用空行区分两部分。 */
  const meta = [executionMeta, usageMeta].filter(Boolean).join('\n\n')
  /** 结束卡片的正文组件，按回答、执行详情、接收者的顺序填充。 */
  const elements: Record<string, unknown>[] = []

  if (options.status === 'success') {
    /** 优先展示最终回答；空回答则展示状态说明。 */
    const answer = options.answer || options.detail
    if (answer.length <= COMPACT_ANSWER_LENGTH) {
      elements.push({ tag: 'markdown', content: escapeFeishuMarkdown(answer) })
    } else {
      // 超过 900 字符：外层展示摘要，折叠面板内放最多约 6000 字符的回答预览。
      elements.push({
        tag: 'markdown',
        content: `${escapeFeishuMarkdown(compactAnswerPreview(answer))}\n\n_完整回答已收起_`,
      })
      elements.push({
        tag: 'collapsible_panel',
        expanded: false,
        header: collapsibleHeader('查看完整回答'),
        vertical_spacing: '8px',
        padding: '8px 8px 8px 8px',
        elements: [
          {
            tag: 'markdown',
            content: escapeFeishuMarkdown(
              markdownPreview(answer, MAX_CARD_ANSWER_LENGTH),
            ),
          },
        ],
      })
    }
    if (answerNeedsContinuation(answer)) {
      // 这里只生成续发提示；调用方必须另行提取并发送剩余回答。
      elements.push({
        tag: 'markdown',
        content: '_回答较长，剩余内容已继续发送。_',
      })
    }
  } else {
    elements.push({ tag: 'markdown', content: `**${options.detail}**` })
    if (options.technicalDetail) {
      elements.push({
        tag: 'collapsible_panel',
        expanded: false,
        header: collapsibleHeader('查看错误详情'),
        vertical_spacing: '8px',
        padding: '8px 8px 8px 8px',
        elements: [
          {
            tag: 'markdown',
            content: `\`${escapeInlineCode(options.technicalDetail)}\``,
          },
        ],
      })
    }
  }

  if (meta || progress?.activities.length) {
    /** 结束卡片最多保留最近八条已完成调用。 */
    const visible = progress?.activities.slice(0, FINISHED_ACTIVITY_LIMIT) ?? []
    /** 只有存在记录时才追加轨迹标题和列表。 */
    const activityText = visible.length
      ? `\n\n**最近执行轨迹**\n${visible.map(activityLine).join('\n')}`
      : ''
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: collapsibleHeader('执行详情'),
      vertical_spacing: '8px',
      padding: '8px 8px 8px 8px',
      elements: [
        {
          tag: 'markdown',
          content: `${meta || options.detail}${activityText}`,
        },
      ],
    })
  }
  if (options.status === 'success' && options.recipientOpenId) {
    elements.push({ tag: 'hr' })
    elements.push({
      tag: 'markdown',
      content: `**Agent OS** · 发送给：<at id=${options.recipientOpenId}></at>`,
    })
  }
  return elements
}

/** 用 content 作为折叠面板标题，统一设置右侧箭头及展开时的旋转角度。 */
function collapsibleHeader(content: string): Record<string, unknown> {
  return {
    title: { tag: 'plain_text', content },
    vertical_align: 'center',
    icon: {
      tag: 'standard_icon',
      token: 'down-small-ccm_outlined',
      size: '16px 16px',
    },
    icon_position: 'right',
    icon_expanded_angle: -180,
  }
}

/** 根据 options 的状态选择标题样式与正文构建器，返回可交给飞书发送接口的完整卡片。 */
export function buildTaskCard(options: TaskCardOptions): CardJson {
  /** 当前状态的主题色和中文标签。 */
  const style = STATUS_STYLE[options.status]
  return {
    schema: '2.0',
    config: {
      // 使用共享卡片，更新同一条消息时同步所有接收者看到的内容。
      update_multi: true,
      // 消息摘要用于聊天列表等预览位置。
      summary: { content: `${options.title}：${style.label}` },
    },
    header: {
      template: style.template,
      title: {
        tag: 'plain_text',
        content: `${options.title} · ${style.label}`,
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements:
        options.status === 'running'
          ? buildRunningElements(options)
          : buildFinishedElements(options),
    },
  }
}

/** 判断 answer 是否超过卡片内回答长度阈值，供调用方决定是否续发。 */
export function answerNeedsContinuation(answer: string): boolean {
  return answer.length > MAX_CARD_ANSWER_LENGTH
}

/** 从与卡片预览相同的切点提取 answer 剩余正文；只返回文本，不发送消息或补代码围栏。 */
export function answerContinuation(answer: string): string {
  return answer.slice(markdownSplitIndex(answer, MAX_CARD_ANSWER_LENGTH))
}

/**
 * 将 text 拆成可逐条发送的文本块，每块默认最多 4000 字符；maxLength 应传入正整数。
 * 优先在后半段的换行处拆分，否则硬切；每块去除首尾空白，不修复 Markdown 围栏。
 */
export function splitLongText(text: string, maxLength = 4_000): string[] {
  /** 已切出的文本块，顺序与原文一致。 */
  const chunks: string[] = []
  /** 尚未分配到文本块的剩余正文。 */
  let remaining = text
  while (remaining.length > maxLength) {
    /** 本轮长度上限内的最后一个换行位置。 */
    const newline = remaining.lastIndexOf('\n', maxLength)
    /** 换行太靠前时按上限硬切，避免产生过短的块。 */
    const splitAt = newline > maxLength / 2 ? newline : maxLength
    chunks.push(remaining.slice(0, splitAt).trim())
    remaining = remaining.slice(splitAt).trim()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

/** 提交完整 card 的异步操作；由调用方注入，Promise 表示这次提交完成或失败。 */
type UpdateCard = (card: CardJson) => Promise<void>

/**
 * 合并高频卡片进度：push 覆盖待发卡片，首个 push 开启固定窗口（默认一秒），
 * 到期后取出最新卡片并追加到 Promise 链，让已入队请求串行执行。
 * finish 清除未入队进度并在旧请求结束后提交最终卡片；cancel 只停止后续更新。
 * 窗口限制的是取出待发卡片的时机，不保证网络请求之间严格间隔一秒。
 */
export class ThrottledCardUpdater {
  /** 尚未入队的最新卡片；同一窗口内的新 push 会覆盖旧值。 */
  private pendingCard: CardJson | undefined
  /** 当前节流窗口的定时器；undefined 表示没有等待中的窗口。 */
  private timer: ReturnType<typeof setTimeout> | undefined
  /** 已入队更新的串行 Promise 链，避免异步请求乱序覆盖卡片。 */
  private updateChain: Promise<void> = Promise.resolve()
  /** finish 或 cancel 开始时置为 true，阻止继续接收和安排进度。 */
  private closed = false

  /** 注入实际提交操作和窗口长度；创建实例本身不会开启定时器或提交卡片。 */
  constructor(
    /** 实际更新卡片的异步函数，进度提交与最终提交共用。 */
    private readonly updateCard: UpdateCard,
    /** 节流窗口长度，单位毫秒，默认一秒。 */
    private readonly intervalMs = 1_000,
  ) {}

  /** 接收完整 card 并保留为最新进度；有窗口则不重置计时，关闭后静默忽略。 */
  push(card: CardJson): void {
    if (this.closed) return
    this.pendingCard = card
    this.schedule()
  }

  /**
   * 关闭入口、丢弃未入队进度，等待已入队更新后直接提交 finalCard。
   * 旧链失败不会阻止最终提交，但最终提交失败会向调用方抛出。
   * 重复调用直接返回，也不会等待第一次 finish 完成。
   */
  async finish(finalCard: CardJson): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.pendingCard = undefined
    await this.updateChain.catch(() => undefined)
    await this.updateCard(finalCard)
  }

  /**
   * 关闭入口、清除定时器及未入队进度，等待旧更新结束并忽略其错误。
   * 不提交取消状态卡片，也不撤销已入队请求或中止 CLI；这些由调用方负责。
   */
  async cancel(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.pendingCard = undefined
    await this.updateChain.catch(() => undefined)
  }

  /** 没有定时器时创建窗口；到期先释放定时器标记，再把待发卡片交给更新链。 */
  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flushPending()
    }, this.intervalMs)
  }

  /** 取出待发卡片并清空槽位；仍未关闭时追加到更新链，提交结束后检查是否还有新进度。 */
  private flushPending(): void {
    /** 本次取出的卡片引用；后续 push 覆盖 pendingCard 不会改变此变量。 */
    const card = this.pendingCard
    this.pendingCard = undefined
    if (!card || this.closed) return

    this.updateChain = this.updateChain
      .then(() => this.updateCard(card))
      .finally(() => {
        // finally 不会恢复失败链：旧提交失败后，后续 then 会跳过，直到结束流程处理错误。
        if (this.pendingCard && !this.closed) this.schedule()
      })
  }
}
