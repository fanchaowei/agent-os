/**
 * CLI 执行层：通过适配器构造命令参数，启动子进程并逐行解析标准输出，向外转发实时事件。
 * 同时收集会话 ID、最终回答和错误信息，在进程关闭后统一判定结果，并处理超时与外部取消。
 */
import { createInterface } from 'node:readline'
import { killCli, spawnCli } from './spawn-cli.js'
import type { CliAdapter, CliEvent, CliRunResult } from './types.js'
import { promptInputForPlatform } from './types.js'

/** 单次 CLI 运行的默认超时时间：10 分钟，单位为毫秒。 */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/** 启动一轮 CLI 任务所需的输入、运行配置和实时事件回调。 */
export interface RunCliOptions {
  /** CLI 适配器，提供可执行命令、参数构造及输出解析能力。 */
  adapter: CliAdapter
  /** 本轮要发送给 CLI 的完整任务文本。 */
  prompt: string
  /** 子进程的工作目录，决定 CLI 从哪个项目目录开始执行。 */
  cwd: string
  /** 要续接的历史会话 ID；省略时使用新会话参数。 */
  sessionId?: string
  /** 外部取消信号，例如用户点击停止任务时触发。 */
  signal?: AbortSignal
  /** 本轮执行的超时时间（毫秒）；未提供时使用 DEFAULT_TIMEOUT_MS。 */
  timeoutMs?: number
  /**
   * 每解析出一个事件便同步调用，让外层在任务结束前更新日志或卡片进度。
   * @param event 从一行 CLI 输出解析出的结构化事件。
   */
  onEvent?: (event: CliEvent) => void
}

/**
 * 执行一轮 CLI 任务，返回包含回答、会话 ID 及可选统计信息的 Promise。
 * 先选择 prompt 的输入方式并构造参数，再启动子进程、写入输入、监听输出及进程事件；
 * 输出中的 result 事件只暂存结果，直到进程关闭且各项检查通过后才兑现 Promise。
 * 超时、外部取消、CLI 错误事件、非零退出或缺少最终结果都会使 Promise 拒绝。
 * @param options 适配器、任务文本、工作目录、会话及生命周期配置。
 * @returns 子进程成功关闭后的最终结果；执行失败时以 Error 拒绝。
 */
export function runCli(options: RunCliOptions): Promise<CliRunResult> {
  /** 解构本轮配置：适配器和任务输入用于启动进程，信号、超时和回调用于控制执行过程。 */
  const {
    adapter,
    prompt,
    cwd,
    sessionId,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onEvent,
  } = options

  /** 平台对应的任务输入模式：Windows 走 stdin，其他平台走命令行参数。 */
  const promptInput = promptInputForPlatform(process.platform)
  /** 是否需要将完整 prompt 写入标准输入，避免 Windows 的 cmd 拆分或转义正文。 */
  const useStdin = promptInput === 'stdin'

  /** 有历史会话 ID 时构造续接参数，否则构造新会话参数；两种方式均传入输入模式。 */
  const args = sessionId
    ? adapter.buildResumeArgs(prompt, sessionId, promptInput)
    : adapter.buildArgs(prompt, promptInput)

  // resolve 返回成功结果，reject 返回失败原因；后续进程回调通过 settled 避免重复收尾。
  return new Promise((resolve, reject) => {
    /**
     * 本轮 CLI 子进程。三个标准流均使用 pipe，确保 stdin 可写、stdout/stderr 可读；
     * stdio 的字面量元组也让 spawnCli 重载推断出对应的流类型。
     */
    const child = spawnCli(adapter.command, args, {
      cwd,
      signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // end 写入正文后关闭输入端，让 CLI 收到输入结束；参数模式不再写入正文，直接关闭输入端。
    if (child.stdin) {
      if (useStdin) child.stdin.end(prompt, 'utf8')
      else child.stdin.end()
    }

    // spawn 的 signal 选项仅终止直接子进程；Windows 使用 cmd 外壳，额外监听取消以清理整棵进程树。
    // 此监听器只触发一次；killCli 在其他平台使用普通的子进程终止方式。
    signal?.addEventListener('abort', () => killCli(child), { once: true })
    /** 将 stdout 流按行读取的接口，每一行都交给适配器解析。 */
    const lines = createInterface({ input: child.stdout })
    /** 最近观察到的有效会话 ID，以调用方传入的历史 ID 为初值。 */
    let observedSessionId = sessionId
    /** 最近一次 result 事件生成的结果，暂存到进程关闭后再返回。 */
    let finalResult: CliRunResult | undefined
    /** CLI error 事件报告的最近一次业务错误，即使进程零退出也应据此判定失败。 */
    let resultError: Error | undefined
    /** 累积的标准错误输出，供进程异常退出时优先作为错误说明。 */
    let stderr = ''
    /** Promise 是否已经完成，避免 error 和 close 等事件重复执行收尾。 */
    let settled = false
    /** 是否由超时触发终止，用于将后续进程错误或关闭转换为明确的超时错误。 */
    let timedOut = false

    /** 超时定时器；到期后先标记原因再终止进程，最终结果由 error 或 close 回调处理。 */
    const timer = setTimeout(() => {
      timedOut = true
      killCli(child)
    }, timeoutMs)

    /** 清除超时定时器，防止已结束的任务继续触发终止操作。 */
    const finish = () => clearTimeout(timer)
    /**
     * 统一处理失败：只执行一次，标记完成并清除定时器，再拒绝 Promise。
     * @param error 本轮任务要返回给调用方的失败原因。
     */
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      finish()
      reject(error)
    }

    /**
     * 解析一行输出，依次转发事件，再维护会话 ID、错误和最终结果。
     * @param line readline 提供的一行文本，不包含行尾换行符。
     */
    lines.on('line', (line) => {
      // event 是适配器从本行解析出的单个事件；一行可对应零个或多个事件。
      for (const event of adapter.parseEvents(line)) {
        onEvent?.(event)
        // 不局限于 session 事件，只要事件携带有效的 sessionId 就更新当前记录。
        if ('sessionId' in event && event.sessionId) {
          observedSessionId = event.sessionId
        }
        if (event.type === 'error') {
          // 先保存 CLI 报告的错误，继续读取后续输出，待关闭时统一判定。
          resultError = new Error(event.message)
          continue
        }
        if (event.type === 'result') {
          // 结果事件没有会话 ID 时沿用此前观察到的 ID，统计信息存在时才加入结果。
          finalResult = {
            answer: event.answer,
            sessionId: event.sessionId ?? observedSessionId,
            ...(event.stats ? { stats: event.stats } : {}),
          }
        }
      }
    })

    /**
     * 累积标准错误输出；stderr 有内容本身不会立即导致任务失败。
     * @param chunk 本次收到的字节缓冲区或字符串，可能只是一条错误信息的一部分。
     */
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })
    /**
     * 处理子进程启动失败、取消等进程级错误，优先将已知的超时或取消原因转换为中文提示。
     * @param error 子进程发出的原始错误，未匹配到超时或取消时直接返回它。
     */
    child.once('error', (error) => {
      if (timedOut) {
        fail(new Error(`${adapter.displayName} 执行超时`))
        return
      }
      if (signal?.aborted) {
        fail(new Error(`${adapter.displayName} 执行已取消`))
        return
      }
      fail(error)
    })
    /**
     * 子进程结束且标准流关闭后统一收尾：依次检查超时、取消、CLI 错误、退出码和最终结果。
     * 全部通过后清除定时器并返回成功结果；失败分支由 fail 收尾，避免提前收到 result 就误判成功。
     * @param code 进程退出码；被信号终止时可能为 null，此处只有 0 被视为正常退出。
     */
    child.once('close', (code) => {
      if (settled) return
      if (timedOut) {
        return fail(new Error(`${adapter.displayName} 执行超时`))
      }
      if (signal?.aborted) {
        return fail(new Error(`${adapter.displayName} 执行已取消`))
      }
      if (resultError) return fail(resultError)
      if (code !== 0) {
        return fail(
          new Error(
            stderr.trim() || `${adapter.displayName} 退出，状态码 ${code}`,
          ),
        )
      }
      if (!finalResult) {
        return fail(new Error(`${adapter.displayName} 没有返回最终结果`))
      }
      settled = true
      finish()
      resolve(finalResult)
    })
  })
}
