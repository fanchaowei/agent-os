import type { CliAdapter, CliEvent, CliRunStats } from './types.js'

/**
 * Claude Code 的 stream-json 原始事件中，本适配器需要读取的字段。
 * 外部 JSON 的字段可能缺失或类型不符，因此先用 unknown 接收，再在使用处检查。
 */
interface ClaudeEvent {
  /** 事件类别，用于区分系统初始化、助手消息、工具返回和最终结果。 */
  type?: unknown
  /** 事件子类别；系统初始化时预期为 init。 */
  subtype?: unknown
  /** 最终结果是否表示执行失败。 */
  is_error?: unknown
  /** 最终回答文本，失败时也可能携带错误说明。 */
  result?: unknown
  /** Claude 会话标识，后续可通过 --resume 继续该会话。 */
  session_id?: unknown
  /** 本次执行耗时，单位为毫秒。 */
  duration_ms?: unknown
  /** 本次执行的对话轮数。 */
  num_turns?: unknown
  /** 汇总的 token 用量，包含输入、输出和缓存相关计数。 */
  usage?: unknown
  /** 按模型记录的用量信息；此处用于读取各模型的上下文窗口容量。 */
  modelUsage?: unknown
  /** 助手或用户消息，内部可能包含 content 内容块和 usage 用量。 */
  message?: unknown
}

/** 消息中的内容块；通过 type 区分工具调用（tool_use）和工具返回（tool_result）。 */
interface ClaudeContentBlock {
  /** 内容块类别；其他类别的内容块会在工具事件转换时被忽略。 */
  type?: unknown
  /** 工具调用块自身的标识，用于与返回结果配对。 */
  id?: unknown
  /** 工具名称，例如 Read、Bash 或 Edit。 */
  name?: unknown
  /** 工具调用参数，用于提取路径、搜索词等展示信息。 */
  input?: unknown
  /** 工具返回块引用的调用标识，对应工具调用块的 id。 */
  tool_use_id?: unknown
  /** 工具返回是否表示失败，仅布尔值 true 被视为失败。 */
  is_error?: unknown
}

/** 将 CLI 工具名称映射为飞书卡片上的中文动作标签；未知工具在解析时使用兜底标签。 */
const TOOL_LABELS: Record<string, string> = {
  Agent: '启动子任务',
  Bash: '运行命令',
  Edit: '修改文件',
  Glob: '查找文件',
  Grep: '搜索代码',
  Read: '读取文件',
  Task: '启动子任务',
  TaskOutput: '等待子任务完成',
  WebFetch: '读取网页',
  WebSearch: '搜索资料',
  Write: '写入文件',
}

/**
 * 判断值是否为非 null 对象，让 TypeScript 允许后续按字段读取。
 * 这里只做基础对象检查，数组也会通过；具体字段仍需调用方进一步验证。
 * @param value 外部 JSON 中尚未确定类型的值。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 只保留有限数值，过滤字符串、NaN 和 Infinity；无效或缺失时返回 undefined。
 * @param value 待检查的原始数值字段，不会把数字字符串自动转换为数字。
 */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 缩短文件路径以便卡片展示：统一分隔符、移除空片段，再保留末尾几段。
 * @param value 原始路径；以 / 开头时保留末尾两段，其他路径保留末尾三段。
 */
function shortPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  // 将 Windows 反斜杠统一成正斜杠，后续使用相同规则拆分。
  const normalized = value.replaceAll('\\', '/')
  // 去掉连续分隔符、开头或末尾分隔符产生的空字符串。
  const parts = normalized.split('/').filter(Boolean)
  return parts.slice(normalized.startsWith('/') ? -2 : -3).join('/')
}

/**
 * 将文本整理为单行，超出长度时截断并加省略号；空文本不生成展示详情。
 * @param value 待整理的原始文本，非字符串会被忽略。
 * @param maxLength 展示长度上限（按 JavaScript 字符串长度计），包含末尾省略号。
 */
function shortText(value: unknown, maxLength = 72): string | undefined {
  if (typeof value !== 'string') return undefined
  // 将换行、制表符和连续空白合并成一个空格，再去掉首尾空白。
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}

/**
 * 按工具类别挑选参数中的关键字段，整理成适合卡片展示的简短详情。
 * 文件工具展示路径，搜索工具展示搜索词，命令和子任务展示描述；未支持的工具省略详情。
 * @param name Claude 工具名称，用于决定读取哪个参数字段。
 * @param input 未验证的工具参数，必须先通过对象检查。
 */
function toolDetail(name: string, input: unknown): string | undefined {
  if (!isRecord(input)) return undefined
  if (['Read', 'Edit', 'Write'].includes(name)) {
    return shortPath(input.file_path)
  }
  if (name === 'Glob') return shortText(input.pattern)
  if (name === 'Grep') return shortText(input.pattern)
  if (name === 'Bash') return shortText(input.description)
  if (name === 'Agent' || name === 'Task') return shortText(input.description)
  if (name === 'WebSearch') return shortText(input.query)
  return undefined
}

/**
 * 从消息中提取 content 数组，并过滤非对象元素；具体块类型由事件解析逻辑判断。
 * @param message 原始消息；不存在有效 content 数组时返回空数组。
 */
function messageBlocks(message: unknown): ClaudeContentBlock[] {
  if (!isRecord(message) || !Array.isArray(message.content)) return []
  return message.content.filter(isRecord)
}

/**
 * 累加输入、输出、缓存读取和缓存创建四类 token 的有效数值。
 * 所有计数都缺失时返回 undefined，避免把“没有统计”误当成“消耗为零”。
 * @param usage Claude 提供的原始用量对象。
 */
function usageTokens(usage: unknown): number | undefined {
  if (!isRecord(usage)) return undefined
  // value 是当前待筛选的计数；类型谓词让筛选结果收窄为 number[]，其中保留有效的 0。
  const values = [
    asNumber(usage.input_tokens),
    asNumber(usage.output_tokens),
    asNumber(usage.cache_read_input_tokens),
    asNumber(usage.cache_creation_input_tokens),
  ].filter((value): value is number => value !== undefined)
  // reduce 中 sum 是累计总数，value 是本轮加入的单项计数，初始总数为 0。
  return values.length
    ? values.reduce((sum, value) => sum + value, 0)
    : undefined
}

/**
 * 从各模型的用量记录中提取有效的上下文窗口容量，并取其中最大值。
 * 这里读取的是模型容量，不是已使用的 token 数；没有有效容量时返回 undefined。
 * @param modelUsage 按模型名称组织的原始用量记录。
 */
function contextWindowTokens(modelUsage: unknown): number | undefined {
  if (!isRecord(modelUsage)) return undefined
  // usage 是单个模型记录，value 是转换后的容量；仅保留大于 0 的有限数值。
  const windows = Object.values(modelUsage)
    .filter(isRecord)
    .map((usage) => asNumber(usage.contextWindow))
    .filter((value): value is number => value !== undefined && value > 0)
  return windows.length ? Math.max(...windows) : undefined
}

/**
 * 把最终事件中的耗时、轮数和用量映射为项目统一的运行统计。
 * 各项单独校验，允许部分统计缺失；全部缺失时不生成统计对象。
 * @param event Claude 的最终结果事件。
 */
function parseStats(event: ClaudeEvent): CliRunStats | undefined {
  // 用量字段无效时用空对象兜底，使下面的字段读取统一得到 undefined。
  const usage = isRecord(event.usage) ? event.usage : {}
  // 汇总四类 token 的用量；不代表模型上下文窗口的容量。
  const totalTokens = usageTokens(usage)
  // 多个模型记录中最大的有效上下文窗口容量。
  const windowTokens = contextWindowTokens(event.modelUsage)
  // 统一统计对象，各字段保留 undefined 以表达原始事件未提供有效数据。
  const stats: CliRunStats = {
    durationMs: asNumber(event.duration_ms),
    turns: asNumber(event.num_turns),
    totalTokens,
    inputTokens: asNumber(usage.input_tokens),
    outputTokens: asNumber(usage.output_tokens),
    cacheReadTokens: asNumber(usage.cache_read_input_tokens),
    cacheCreationTokens: asNumber(usage.cache_creation_input_tokens),
    contextWindowTokens: windowTokens,
  }
  // value 是被检查的单项统计；只要有一项有效（包括 0），就返回整个统计对象。
  return Object.values(stats).some((value) => value !== undefined)
    ? stats
    : undefined
}

/**
 * 构造新执行和恢复执行共用的参数：-p 提交提示词，stream-json 配合 verbose 输出事件流。
 * @param prompt 本轮交给 Claude Code 的提示词，作为一个独立命令行参数传递。
 */
function outputArgs(prompt: string): string[] {
  return ['-p', prompt, '--output-format', 'stream-json', '--verbose']
}

/**
 * Claude Code CLI 与项目统一 CLI 接口之间的适配层。
 * 先构造启动或恢复会话的参数，再把逐行 JSON 输出转换为会话、工具、用量和结果事件，
 * 供上层执行器和飞书卡片消费；本类不负责启动进程或发送飞书消息。
 */
export class ClaudeAdapter implements CliAdapter {
  /** 适配器的固定标识，as const 将类型收窄为字面量 'claude'。 */
  readonly id = 'claude' as const
  /** 上层执行器启动子进程时使用的命令名称。 */
  readonly command = 'claude'
  /** 面向用户展示的 CLI 名称。 */
  readonly displayName = 'Claude Code'

  /**
   * 生成一次新执行的参数，复用统一的 JSON 事件流输出配置。
   * @param prompt 本次任务的提示词。
   */
  buildArgs(prompt: string): string[] {
    return outputArgs(prompt)
  }

  /**
   * 在公共参数前添加 --resume，让本轮提示词继续已有会话。
   * @param prompt 本轮追加的提示词。
   * @param sessionId 之前从 CLI 事件中获得的会话标识。
   */
  buildResumeArgs(prompt: string, sessionId: string): string[] {
    return ['--resume', sessionId, ...outputArgs(prompt)]
  }

  /**
   * 提供只取首个事件的便捷入口；一行产生多个事件时，其余事件不会返回。
   * @param line CLI 输出的一行 JSON；需要完整事件列表时应调用 parseEvents。
   */
  parseEvent(line: string): CliEvent | undefined {
    return this.parseEvents(line)[0]
  }

  /**
   * 解析一行 JSON，并根据 type 转换为零个或多个统一事件：
   * system/init 提供会话，assistant 提供用量和工具开始，user 提供工具结束，result 提供最终结果。
   * JSON 语法错误或无需处理的事件返回空数组；一条助手消息可能产生多个工具事件。
   * @param line CLI 输出流中已经按行切分的 JSON 文本。
   */
  parseEvents(line: string): CliEvent[] {
    // 暂存解析后的原始事件；类型断言只影响编译期，使用字段时仍需运行时检查。
    let event: ClaudeEvent
    try {
      event = JSON.parse(line) as ClaudeEvent
    } catch {
      // 忽略无法解析为 JSON 的输出行，继续等待后续事件。
      return []
    }

    // 只接收字符串会话标识；缺失时不向结果中附加 sessionId。
    const sessionId =
      typeof event.session_id === 'string' ? event.session_id : undefined
    if (event.type === 'system' && event.subtype === 'init' && sessionId) {
      // 初始化事件让上层尽早记录会话，后续可继续该任务。
      return [{ type: 'session', sessionId }]
    }
    if (event.type === 'assistant') {
      // 助手消息的用量位于 message.usage，与最终结果顶层的 usage 分开读取。
      const message = isRecord(event.message) ? event.message : {}
      // 由本条助手消息中的四类计数计算得到的 token 总量。
      const usedTokens = usageTokens(message.usage)
      // 有用量数据时生成一个上下文事件，否则为空；后续与工具事件合并返回。
      const contextEvent: CliEvent[] =
        usedTokens === undefined ? [] : [{ type: 'context', usedTokens }]
      // block 是当前内容块；每块返回零个或一个事件，flatMap 将各块结果展开成单层数组。
      const toolEvents = messageBlocks(event.message).flatMap(
        (block): CliEvent[] => {
          if (
            block.type !== 'tool_use' ||
            typeof block.id !== 'string' ||
            typeof block.name !== 'string'
          )
            return []
          // 从已验证的工具名称及原始参数中提取可选展示详情。
          const detail = toolDetail(block.name, block.input)
          return [
            {
              type: 'tool_start',
              toolUseId: block.id,
              toolName: block.name,
              // 未收录的工具仍展示原始名称，避免丢失动作信息。
              label: TOOL_LABELS[block.name] ?? `调用 ${block.name}`,
              ...(detail ? { detail } : {}),
            },
          ]
        },
      )
      return [...contextEvent, ...toolEvents]
    }
    if (event.type === 'user') {
      // 工具返回位于 user 消息中；block 是当前内容块，只有 tool_result 才生成结束事件。
      return messageBlocks(event.message).flatMap((block): CliEvent[] => {
        if (
          block.type !== 'tool_result' ||
          typeof block.tool_use_id !== 'string'
        ) {
          return []
        }
        return [
          {
            type: 'tool_end',
            // 通过调用标识与之前的 tool_start 配对，而非依赖工具名称。
            toolUseId: block.tool_use_id,
            failed: block.is_error === true,
          },
        ]
      })
    }
    // 其他事件不参与展示；到这里仅继续处理最终结果事件。
    if (event.type !== 'result') return []
    if (event.is_error) {
      // 执行失败时优先使用 CLI 的文字说明，没有文字时使用默认错误消息。
      return [
        {
          type: 'error',
          message:
            typeof event.result === 'string'
              ? event.result
              : 'Claude Code 执行失败',
          ...(sessionId ? { sessionId } : {}),
        },
      ]
    }
    if (typeof event.result !== 'string') return []
    // 成功结果附带可选运行统计；原始事件没有有效统计时省略 stats 字段。
    const stats = parseStats(event)
    return [
      {
        type: 'result',
        answer: event.result,
        ...(sessionId ? { sessionId } : {}),
        ...(stats ? { stats } : {}),
      },
    ]
  }
}
