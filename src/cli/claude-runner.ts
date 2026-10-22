import { createInterface } from 'node:readline'
import { spawnCli } from './spawn-cli.js'

/** 一次 Claude Code 调用成功后的结果，供上层读取回答并记录会话标识。 */
export interface ClaudeRunResult {
  /** Claude Code 最终返回的回答文本。 */
  answer: string
  /** CLI 返回的会话标识；未提供时为 undefined。 */
  sessionId?: string
}

/** 启动 Claude Code 所需的任务输入、工作目录和可选取消信号。 */
export interface RunClaudeOptions {
  /** 交给 Claude Code 执行的用户提示词。 */
  prompt: string
  /** 子进程的工作目录，决定 Claude Code 在哪个项目中执行任务。 */
  cwd: string
  /** 由调用方触发的取消信号，传给子进程并用于识别取消状态。 */
  signal?: AbortSignal
}

/** stream-json 输出中的最终结果事件；这里只声明当前执行器会读取的字段。 */
interface ClaudeResultEvent {
  /** 用于从其他流式事件中识别最终结果事件的类型标记。 */
  type: 'result'
  /** Claude Code 是否将本次执行标记为失败。 */
  is_error?: boolean
  /** 成功时的回答文本，或失败时的错误说明。 */
  result?: string
  /** 本次执行对应的 Claude Code 会话标识。 */
  session_id?: string
}

/**
 * 根据事件类型筛选最终结果事件，让后续代码能够读取结果字段。
 * @param value 从一行 JSON 解析出的未知值；这里只检查对象及 type，不校验其余字段。
 */
function isResultEvent(value: unknown): value is ClaudeResultEvent {
  if (!value || typeof value !== 'object') return false
  return (value as { type?: unknown }).type === 'result'
}

/**
 * 启动 Claude Code，逐行解析其 JSON 输出，并在进程结束后返回最终回答。
 * 执行期间先缓存结果、业务错误和标准错误；结束时依次检查取消、业务错误、
 * 退出码和结果是否存在。进程或输入流发生错误时，通过统一入口拒绝 Promise。
 * @param options 提示词、项目工作目录，以及可选的取消信号。
 * @returns 执行成功时的回答和会话标识；执行失败或取消时拒绝 Promise。
 */
export function runClaude(options: RunClaudeOptions): Promise<ClaudeRunResult> {
  // Windows 下 prompt 走 stdin（`-p` 后不跟参数即读 stdin），其他平台直接作为 `-p <prompt>`。
  /** 当前平台是否通过标准输入传递提示词，避免提示词经过 Windows shell 参数解析。 */
  const useStdin = process.platform === 'win32'
  /** CLI 启动参数：使用非交互模式，并开启带详细事件的逐行 JSON 输出。 */
  const args = [
    '-p',
    ...(useStdin ? [] : [options.prompt]),
    '--output-format',
    'stream-json',
    '--verbose',
  ]

  // resolve 用于交付成功结果，reject 用于报告失败；两者由 settled 统一防止重复调用。
  return new Promise((resolve, reject) => {
    /** Claude Code 子进程；Windows 开启 stdin 管道，其他平台直接忽略标准输入。 */
    const child = useStdin
      ? spawnCli('claude', args, {
          cwd: options.cwd,
          signal: options.signal,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      : spawnCli('claude', args, {
          cwd: options.cwd,
          signal: options.signal,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
    /** 将标准输出拆成完整的行，避免一个 JSON 事件被底层数据块拆开而解析失败。 */
    const lines = createInterface({ input: child.stdout })
    /** 最近一次成功结果事件中的回答，等进程正常结束后再交付给调用方。 */
    let finalResult: ClaudeRunResult | undefined
    /** 结果事件报告的业务错误，即使进程退出码为 0，也应按失败处理。 */
    let resultError: Error | undefined
    /** 累积标准错误内容，在进程异常退出时优先用作错误说明。 */
    let stderr = ''
    /** 标记 Promise 是否已经完成，避免不同异步事件重复处理成功或失败。 */
    let settled = false

    /**
     * 统一处理失败：首次调用时标记完成并拒绝 Promise，后续调用直接返回。
     * @param error 要交给调用方的错误，可能来自进程、输入流或结果校验。
     */
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    }

    /**
     * 处理每行输出：忽略非 JSON 内容及非结果事件，缓存最终回答或业务错误。
     * @param line 标准输出中的一整行文本。
     */
    lines.on('line', (line) => {
      /** 解析后的事件先使用 unknown，经过类型判断后再读取结果字段。 */
      let event: unknown
      try {
        event = JSON.parse(line)
      } catch {
        return
      }
      if (!isResultEvent(event)) return
      if (event.is_error) {
        resultError = new Error(event.result || 'Claude Code 执行失败')
        return
      }
      if (typeof event.result === 'string') {
        finalResult = {
          answer: event.result,
          sessionId: event.session_id,
        }
      }
    })

    /**
     * 收集标准错误，供进程退出码异常时生成可读的错误信息。
     * @param chunk 本次收到的标准错误数据块，统一转为字符串后追加。
     */
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })
    /**
     * 处理子进程错误；若取消信号已触发，则将错误转换为明确的取消提示。
     * @param error 子进程启动、运行或被取消时触发的错误。
     */
    child.once('error', (error) => {
      if (options.signal?.aborted) {
        fail(new Error('Claude Code 执行已取消'))
        return
      }
      fail(error)
    })
    /**
     * 在子进程结束且标准流关闭后，按优先级判断失败原因，校验通过才返回结果。
     * @param code 子进程退出码；0 表示正常退出，被信号终止时可能为 null。
     */
    child.once('close', (code) => {
      if (settled) return
      if (options.signal?.aborted) {
        return fail(new Error('Claude Code 执行已取消'))
      }
      if (resultError) return fail(resultError)
      if (code !== 0) {
        return fail(
          new Error(stderr.trim() || `Claude Code 退出，状态码 ${code}`),
        )
      }
      if (!finalResult) {
        return fail(new Error('Claude Code 没有返回最终结果'))
      }
      settled = true
      resolve(finalResult)
    })

    if (useStdin && child.stdin) {
      // 输入流写入失败也走统一失败入口；end 写入完整提示词并关闭输入，通知 CLI 开始处理。
      child.stdin.once('error', fail)
      child.stdin.end(options.prompt, 'utf8')
    }
  })
}
