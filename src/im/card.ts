/**
 * 飞书任务卡片：构建卡片内容，并把高频进度合并成低频更新。
 */

export type CardJson = Record<string, unknown>
export type TaskStatus = 'running' | 'success' | 'failed'

export interface TaskCardOptions {
  title: string
  status: TaskStatus
  progress: number
  detail: string // 当前在做什么
  activities?: string[]
}

const STATUS_STYLE = {
  running: { template: 'blue', label: '运行中' },
  success: { template: 'green', label: '已完成' },
  failed: { template: 'red', label: '执行失败' },
} as const

// 设置进度在 0-100 之间
function clampProgress(progress: number): number {
  return Math.min(100, Math.max(0, Math.round(progress)))
}

// 用 █ 来代替进度显示
function buildProgressBar(progress: number): string {
  const filled = Math.round(progress / 10)
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`
}

// 归一化进度、再查出对应样式、再拼出最近进展文本，最后组装成对象
export function buildTaskCard(options: TaskCardOptions): CardJson {
  const progress = clampProgress(options.progress)
  const style = STATUS_STYLE[options.status]
  const activities = options.activities ?? []
  const activityText = activities.length
    ? `\n\n**最近进展**\n${activities.map((item) => `- ${item}`).join('\n')}`
    : ''

  return {
    schema: '2.0',
    config: {
      update_multi: true, // 返回的卡片是一张共享卡片
      summary: { content: `${options.title}：${style.label}` }, // 控制聊天列表里的消息预览
    },
    header: {
      template: style.template,
      title: { tag: 'plain_text', content: options.title },
    },
    body: {
      direction: 'vertical',
      elements: [
        {
          tag: 'markdown',
          content: [
            `**状态：** ${style.label}`,
            `**进度：** ${buildProgressBar(progress)} ${progress}%`,
            `**当前：** ${options.detail}${activityText}`,
          ].join('\n\n'),
        },
        {
          tag: 'button',
          text: {
            tag: 'plain_text',
            content: options.status === 'running' ? '任务执行中' : style.label,
          },
          type: options.status === 'success' ? 'primary' : 'default',
          disabled: true,
        },
      ],
    },
  }
}

/** 实际提交卡片的异步函数；card 是要发送的完整卡片，Promise 表示本次提交何时结束。 */
type UpdateCard = (card: CardJson) => Promise<void>

/**
 * 把高频任务进展合并成较低频的卡片更新，减少对飞书更新接口的调用。
 * 首次 push 开启节流窗口（默认两秒），窗口内后续 push 只覆盖待发卡片，
 * 不重新计时；窗口到期后，把当时最新的卡片加入 Promise 链，按顺序提交。
 * finish 会取消尚未入队的进度更新，等待已入队的更新结束，再提交最终卡片。
 */
export class ThrottledCardUpdater {
  /** 当前窗口内最新的卡片；新进展直接覆盖旧进展，无需逐条发送。 */
  private pendingCard: CardJson | undefined
  /** 当前节流窗口的定时器；undefined 表示没有等待触发的窗口。 */
  private timer: ReturnType<typeof setTimeout> | undefined
  /** 串联已入队的更新，避免多个异步请求并发提交导致旧卡片覆盖新卡片。 */
  private updateChain: Promise<void> = Promise.resolve()
  /** finish 开始时置为 true，阻止继续接收进展或安排新的进度提交。 */
  private closed = false

  /**
   * 注入实际更新卡片的操作和节流间隔；创建实例时不会启动定时器。
   * @param updateCard 提交完整卡片的异步操作，由调用方负责对接飞书接口。
   * @param intervalMs 从窗口开启到取出最新卡片的等待毫秒数，默认两秒。
   */
  constructor(
    /** 实际执行网络更新的函数，进度更新和最终更新共用此操作。 */
    private readonly updateCard: UpdateCard,
    /** 节流窗口长度；约束取出待发卡片的时机，不代表请求完成所需时间。 */
    private readonly intervalMs = 2_000,
  ) {}

  /**
   * 接收一次进展，保留最新卡片，并在没有定时器时开启节流窗口。
   * @param card 本次进展对应的完整卡片；窗口内较早的卡片会被它替换。
   * @throws 更新器已经开始结束流程时抛错，提醒调用方停止推送。
   */
  push(card: CardJson): void {
    if (this.closed) throw new Error('卡片更新器已经结束')
    this.pendingCard = card
    this.schedule()
  }

  /**
   * 关闭进展入口、清理尚未入队的更新，等待更新链后直接提交最终卡片。
   * 最终卡片不再等待节流窗口；等待旧更新是为了让最终状态最后提交。
   * 重复调用会直接返回，不会再次提交，也不会等待首次 finish 完成。
   * 更新链或最终提交失败时，异常会向调用方传播，更新器仍保持关闭。
   * @param finalCard 任务结束时需要显示的完整卡片。
   */
  async finish(finalCard: CardJson): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    // 尚未入队的进度由最终卡片替代；已进入 updateChain 的更新仍会继续执行。
    this.pendingCard = undefined
    await this.updateChain
    await this.updateCard(finalCard)
  }

  /** 已有窗口时保持原定触发时间，否则创建一个到期后取出待发卡片的窗口。 */
  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      // 先释放定时器标记，让后续 push 可以开启下一个窗口。
      this.timer = undefined
      this.flushPending()
    }, this.intervalMs)
  }

  /**
   * 取出并清空待发卡片，确认仍可更新后，将这张卡片追加到串行更新链。
   * 提交结束时检查期间收到的新进展，必要时为它安排后续窗口。
   */
  private flushPending(): void {
    /** 当前窗口结束时的卡片快照；后续 push 不会改变这次已取出的卡片引用。 */
    const card = this.pendingCard
    this.pendingCard = undefined
    if (!card || this.closed) return

    this.updateChain = this.updateChain
      .then(() => this.updateCard(card))
      .finally(() => {
        // finally 在成功或失败时都会执行，但不会吞掉异常或恢复失败的更新链。
        if (this.pendingCard && !this.closed) this.schedule()
      })
  }
}
