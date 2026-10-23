export type CliId = 'claude'

export type CliPromptInput = 'argument' | 'stdin'

// Windows 上 prompt 必须走 stdin（避免 cmd 对命令行参数转义/乱码），其他平台直接走参数。
export function promptInputForPlatform(
  platform: NodeJS.Platform,
): CliPromptInput {
  return platform === 'win32' ? 'stdin' : 'argument'
}

export type CliEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'result'; answer: string; sessionId?: string }
  | { type: 'error'; message: string; sessionId?: string }

export interface CliAdapter {
  readonly id: CliId
  readonly command: string
  readonly displayName: string
  // 新会话怎样组装参数
  buildArgs(prompt: string, promptInput: CliPromptInput): string[]
  // 已有会话怎样续接
  buildResumeArgs(
    prompt: string,
    sessionId: string,
    promptInput: CliPromptInput,
  ): string[]
  // 原始输出怎样变成统一事件
  parseEvent(line: string): CliEvent | undefined
}

export interface CliRunResult {
  answer: string
  sessionId?: string
}
