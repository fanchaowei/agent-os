import type { CliAdapter, CliEvent, CliPromptInput } from './types.js'

interface ClaudeEvent {
  type?: unknown
  subtype?: unknown
  is_error?: unknown
  result?: unknown
  session_id?: unknown
}

function outputArgs(prompt: string, promptInput: CliPromptInput): string[] {
  // Windows 下 prompt 走 stdin（`-p` 后不跟参数即读 stdin），避免 cmd 对中文参数转义/乱码；
  // 其他平台直接作为 `-p <prompt>` 命令行参数。
  return [
    '-p',
    ...(promptInput === 'argument' ? [prompt] : []),
    '--output-format',
    'stream-json',
    '--verbose',
  ]
}

export class ClaudeAdapter implements CliAdapter {
  readonly id = 'claude' as const
  readonly command = 'claude'
  readonly displayName = 'Claude Code'

  buildArgs(prompt: string, promptInput: CliPromptInput): string[] {
    return outputArgs(prompt, promptInput)
  }

  buildResumeArgs(
    prompt: string,
    sessionId: string,
    promptInput: CliPromptInput,
  ): string[] {
    return ['--resume', sessionId, ...outputArgs(prompt, promptInput)]
  }

  // 将 claude 返回的 json 转变为统一格式的数据
  parseEvent(line: string): CliEvent | undefined {
    let event: ClaudeEvent
    try {
      event = JSON.parse(line) as ClaudeEvent
    } catch {
      return undefined
    }

    const sessionId =
      typeof event.session_id === 'string' ? event.session_id : undefined

    if (event.type === 'system' && event.subtype === 'init' && sessionId) {
      return { type: 'session', sessionId }
    }

    if (event.type !== 'result') return undefined

    if (event.is_error) {
      return {
        type: 'error',
        message:
          typeof event.result === 'string'
            ? event.result
            : 'Claude Code 执行失败',
        ...(sessionId ? { sessionId } : {}),
      }
    }

    if (typeof event.result !== 'string') return undefined

    return {
      type: 'result',
      answer: event.result,
      ...(sessionId ? { sessionId } : {}),
    }
  }
}
