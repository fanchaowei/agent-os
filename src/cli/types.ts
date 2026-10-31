/**
 * CLI 适配器与执行器共用的类型契约。
 * 适配器负责构造启动参数、把原始输出转换为统一事件；执行器负责启动进程、转发事件并汇总结果。
 */

/** 项目支持的 CLI 标识；目前支持 Claude Code 和 Codex。 */
export type CliId = 'claude' | 'codex'

/** 提示词的传递方式：argument 表示命令行参数，stdin 表示子进程的标准输入。 */
export type CliPromptInput = 'argument' | 'stdin'

/**
 * 根据操作系统选择提示词的传递方式，供适配器构造参数和执行器写入输入时共同使用。
 * Windows 使用 stdin，避免 cmd 拆分、转义正文或造成乱码；其他平台使用命令行参数。
 * @param platform Node.js 平台标识，执行器通常传入 process.platform。
 * @returns 当前平台应使用的提示词输入方式。
 */
export function promptInputForPlatform(
  platform: NodeJS.Platform,
): CliPromptInput {
  return platform === 'win32' ? 'stdin' : 'argument'
}

/** 一轮 CLI 执行的统计信息；各字段可独立缺失，undefined 表示未提供数据，而非数值为零。 */
export interface CliRunStats {
  /** 本轮执行耗时，单位为毫秒。 */
  durationMs?: number
  /** 本轮执行的对话轮数。 */
  turns?: number
  /** token 总用量；当前 Claude 适配器累加输入、输出、缓存读取和缓存创建四类计数。 */
  totalTokens?: number
  /** 输入 token 数；当前 Claude 适配器直接读取 input_tokens，缓存计数另列。 */
  inputTokens?: number
  /** 模型生成的输出 token 数。 */
  outputTokens?: number
  /** 从缓存读取的输入 token 数。 */
  cacheReadTokens?: number
  /** 用于创建缓存的输入 token 数。 */
  cacheCreationTokens?: number
  /** 已使用的上下文 token 数；当前 Claude 适配器的最终统计尚未填充此字段。 */
  contextUsedTokens?: number
  /** 模型上下文窗口容量；当前 Claude 适配器取各模型有效容量的最大值。 */
  contextWindowTokens?: number
}

/**
 * 适配器解析 CLI 输出后产生的统一事件，通过 type 字段区分不同的数据结构。
 * 执行器逐个转发事件，让上层更新会话、工具进度和用量，并在进程结束时汇总最终结果。
 */
export type CliEvent =
  | {
      /** 会话初始化事件，供上层尽早记录可续接的会话。 */
      type: 'session'
      /** CLI 返回的会话标识，后续可用于恢复对话。 */
      sessionId: string
    }
  | {
      /** 工具开始执行事件。 */
      type: 'tool_start'
      /** 本次工具调用的唯一标识，用于与结束事件配对。 */
      toolUseId: string
      /** CLI 原始工具名称，例如 Read、Bash 或 Edit。 */
      toolName: string
      /** 面向用户展示的动作标签，例如“读取文件”。 */
      label: string
      /** 可选的简短执行详情，例如文件路径、搜索词或命令描述。 */
      detail?: string
    }
  | {
      /** 工具执行结束事件。 */
      type: 'tool_end'
      /** 对应 tool_start 的调用标识，同名工具的多次调用也可据此区分。 */
      toolUseId: string
      /** 本次工具调用是否失败；不直接代表整轮 CLI 任务失败。 */
      failed: boolean
    }
  | {
      /** 运行过程中的上下文用量更新事件。 */
      type: 'context'
      /** 当前 Claude 适配器按单条助手消息汇总的 token 用量，并非整轮累计用量或窗口容量。 */
      usedTokens: number
    }
  | {
      /** 独立的运行统计更新事件。 */
      type: 'stats'
      /** 本次事件携带的统计信息，允许仅包含部分指标。 */
      stats: CliRunStats
    }
  | {
      /** CLI 返回最终回答的事件；执行器仍需等待进程关闭并检查退出状态。 */
      type: 'result'
      /** 本轮任务的最终回答文本。 */
      answer: string
      /** 结果中携带的会话标识；缺失时执行器沿用此前记录的会话标识。 */
      sessionId?: string
      /** CLI 提供的本轮运行统计。 */
      stats?: CliRunStats
    }
  | {
      /** CLI 报告的业务错误事件，执行器记录后在收尾时判定任务失败。 */
      type: 'error'
      /** 错误说明，供日志记录或向用户展示。 */
      message: string
      /** 错误事件携带的会话标识，便于保留当前会话。 */
      sessionId?: string
    }

/**
 * 不同编程 CLI 的统一适配接口，隔离各自的命令名称、参数格式和输出协议。
 * 执行器先调用参数构造方法启动进程，再把标准输出逐行交给 parseEvents 转换为统一事件。
 */
export interface CliAdapter {
  /** 适配器的固定标识，用于区分 CLI 类型。 */
  readonly id: CliId
  /** 启动子进程所用的可执行命令，例如 claude。 */
  readonly command: string
  /** 日志和错误提示中面向用户展示的 CLI 名称。 */
  readonly displayName: string
  /**
   * 构造新会话的命令行参数，并启用适合逐行解析的输出格式。
   * stdin 模式下不把提示词放入参数列表，由执行器写入子进程标准输入。
   * @param prompt 本轮任务的完整提示词。
   * @param promptInput 提示词的输入方式，应与执行器实际发送方式一致。
   * @returns 传给 CLI 命令的参数数组。
   */
  buildArgs(prompt: string, promptInput: CliPromptInput): string[]
  /**
   * 构造恢复已有会话的命令行参数，指定历史会话并提交本轮提示词。
   * 与新会话共用提示词输入规则及输出格式，具体恢复参数由适配器实现。
   * @param prompt 本轮追加的完整提示词。
   * @param sessionId 要恢复的历史会话标识。
   * @param promptInput 提示词的输入方式，应与执行器实际发送方式一致。
   * @returns 包含会话恢复选项的 CLI 参数数组。
   */
  buildResumeArgs(
    prompt: string,
    sessionId: string,
    promptInput: CliPromptInput,
  ): string[]
  /**
   * 解析一行 CLI 原始输出，将其中的信息转换为零个或多个统一事件。
   * 无需处理或无法解析的输出返回空数组；一行包含多项信息时可返回多个事件。
   * @param line 标准输出中的一行文本，不包含行尾换行符。
   * @returns 按处理顺序排列的事件列表，供执行器依次转发。
   */
  parseEvents(line: string): CliEvent[]
}

/** 执行器在 CLI 进程成功关闭且结果检查通过后，返回给调用方的最终结果。 */
export interface CliRunResult {
  /** 本轮任务的最终回答文本。 */
  answer: string
  /** 可供后续任务续接的会话标识；CLI 未提供时可能缺失。 */
  sessionId?: string
  /** 最终结果事件携带的运行统计；未提供时省略。 */
  stats?: CliRunStats
}
