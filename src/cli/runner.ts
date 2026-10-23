import { createInterface } from 'node:readline'
import { killCli, spawnCli } from './spawn-cli.js'
import type { CliAdapter, CliRunResult } from './types.js'
import { promptInputForPlatform } from './types.js'

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

export interface RunCliOptions {
  adapter: CliAdapter
  prompt: string
  cwd: string
  sessionId?: string
  signal?: AbortSignal
  timeoutMs?: number
}

export function runCli(options: RunCliOptions): Promise<CliRunResult> {
  const {
    adapter,
    prompt,
    cwd,
    sessionId,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options

  // Windows 下 prompt 走 stdin（规避 cmd 转义/乱码），其他平台直接作为命令行参数。
  const promptInput = promptInputForPlatform(process.platform)
  const useStdin = promptInput === 'stdin'
  const args = sessionId
    ? adapter.buildResumeArgs(prompt, sessionId, promptInput)
    : adapter.buildArgs(prompt, promptInput)

  return new Promise((resolve, reject) => {
    // 固定用 `['pipe','pipe','pipe']`，让 stdin 始终可写（spawnCli 返回类型按字面量收窄）。
    const child = spawnCli(adapter.command, args, {
      cwd,
      signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // stdin 模式下把 prompt 写入子进程；否则 prompt 已在命令行参数里，stdin 直接收口。
    if (child.stdin) {
      if (useStdin) child.stdin.end(prompt, 'utf8')
      child.stdin.end()
    }
    const lines = createInterface({ input: child.stdout })
    let observedSessionId = sessionId
    let finalResult: CliRunResult | undefined
    let resultError: Error | undefined
    let stderr = ''
    let settled = false
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      killCli(child)
    }, timeoutMs)

    const finish = () => clearTimeout(timer)
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      finish()
      reject(error)
    }

    lines.on('line', (line) => {
      const event = adapter.parseEvent(line)
      if (!event) return

      if (event.sessionId) observedSessionId = event.sessionId

      if (event.type === 'error') {
        resultError = new Error(event.message)
        return
      }

      if (event.type === 'result') {
        finalResult = {
          answer: event.answer,
          sessionId: event.sessionId ?? observedSessionId,
        }
      }
    })

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })

    child.once('error', (error) => {
      if (timedOut) return fail(new Error(`${adapter.displayName} 执行超时`))
      if (signal?.aborted) {
        return fail(new Error(`${adapter.displayName} 执行已取消`))
      }
      fail(error)
    })

    child.once('close', (code) => {
      if (settled) return
      if (timedOut) return fail(new Error(`${adapter.displayName} 执行超时`))
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
