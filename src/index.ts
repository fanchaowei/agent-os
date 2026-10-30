/**
 * Agent OS 入口。
 * 当前阶段：连上飞书，收到消息原样回一句（echo bot）。
 */
import 'dotenv/config'
import { join, resolve } from 'node:path'
import { ClaudeAdapter } from './cli/claude-adapter.js'
import { runCli } from './cli/runner.js'
import { parseCommand, SlashCommand } from './core/command-parser.js'
import { SessionManager, type Session } from './core/session-manager.js'
import { JsonSessionStore } from './core/session-store.js'
import { requestTaskAbort, type ActiveRun } from './core/task-abort.js'
import { TaskProgressTracker } from './core/task-progress.js'
import {
  answerContinuation,
  answerNeedsContinuation,
  buildTaskCard,
  splitLongText,
  ThrottledCardUpdater,
} from './im/card.js'
import { Bot, IncomingMessage, startBot } from './im/lark.js'
import { extractResourceKeys, resolveMentions } from './im/message-parser.js'

interface StartBotMessage {
  msg: IncomingMessage
  bot: Bot
  resolved: string
  session: Session
  isNew: boolean
  hasThread: boolean
}

//#region 配置获取

const appId = process.env.BOT_A_APP_ID
const appSecret = process.env.BOT_A_APP_SECRET
const cliWorkdir = resolve(process.env.CLAUDE_WORKDIR ?? process.cwd())
const cliAdapter = new ClaudeAdapter()

if (!appId || !appSecret) {
  console.error('缺少 BOT_A_APP_ID / BOT_A_APP_SECRET，请检查 .env')
  process.exit(1)
}

console.log('Agent OS 启动，正在建立飞书长连接…')
console.log(`[CLI] command=${cliAdapter.command} cwd=${cliWorkdir}`)

//#endregion

//#region session

const sessions = await SessionManager.open({
  store: new JsonSessionStore(join('data', 'sessions.json')),
})
console.log(`[会话] 已恢复 ${sessions.size} 个会话`)
// 跨轮次记住每个会话的上下文窗口大小（总容量），键是 sessionId，值是 contextWindowTokens
const contextWindows = new Map<string, number>()

//#endregion

//#region cli runner

function executeCli(
  prompt: string,
  sessionId: string | undefined,
  signal: AbortSignal,
  onEvent: Parameters<typeof runCli>[0]['onEvent'],
) {
  return runCli({
    adapter: cliAdapter,
    prompt,
    cwd: cliWorkdir,
    sessionId,
    signal,
    onEvent,
  })
}

//#endregion

//#region Abort

const activeRuns = new Map<string, ActiveRun>()

//#endregion

//#region utils

const STATUS_LABELS: Record<Session['status'], string> = {
  creating: '创建中',
  active: '执行中',
  idle: '空闲',
  closed: '已关闭',
}

function formatSessionStatus(session: Session): string {
  return [
    `会话：${session.id}`,
    `状态：${STATUS_LABELS[session.status]}`,
    `执行引擎：${session.cliId}`,
    `CLI 会话：${session.cliSessionId ?? '(尚未建立)'}`,
    `话题：${session.threadId}`,
    `更新时间：${session.updatedAt}`,
  ].join('\n')
}
// 将对话状态转为 idle
async function markSessionIdle(sessionId: string): Promise<void> {
  if (sessions.get(sessionId)?.status !== 'active') return
  await sessions.transition(sessionId, 'idle')
  console.log(`[会话] id=${sessionId} status=idle`)
}

// 打印程序启动时的信息
function consoleStartMessage(options: StartBotMessage) {
  const { msg, resolved, session, isNew } = options
  console.log(
    `[收到] chat=${msg.chatId} threadId=${msg.threadId} rootId=${msg.rootId} sender=${msg.senderOpenId}`,
  )
  console.log(`  原文: ${msg.text}`)
  console.log(`  还原: ${resolved}`)
  console.log(
    `  mentions: ${msg.mentions.map((m) => `${m.key}=${m.name}(${m.openId})`).join(', ') || '(无)'}`,
  )
  console.log(
    `  [会话] ${isNew ? '新建' : '复用'} id=${session.id} status=${session.status}`,
  )
}

// 处理命令
async function handleCommand(
  command: SlashCommand | undefined,
  options: StartBotMessage,
) {
  const { msg, bot, hasThread, resolved, session, isNew } = options
  if (command?.name === 'help') {
    await bot.reply(
      msg.messageId,
      ['/status 查看当前会话', '/close 关闭当前会话', '/help 查看命令'].join(
        '\n',
      ),
      hasThread,
    )
    return true
  }
  if (command?.name === 'status') {
    await bot.reply(msg.messageId, formatSessionStatus(session), hasThread)
    return true
  }
  if (command?.name === 'close') {
    const active = activeRuns.get(session.id)
    if (active) {
      active.cancelMode = 'close'
      active.controller.abort()
    }
    if (session.status !== 'closed')
      await sessions.transition(session.id, 'closed')
    await bot.reply(
      msg.messageId,
      '当前会话已关闭。需要继续时，请新开一个话题。',
      hasThread,
    )
    return true
  }

  return false
}

// 处理状态
async function handleStatus(options: StartBotMessage) {
  const { session, bot, msg, hasThread, isNew } = options

  if (session.status === 'closed') {
    await bot.reply(
      msg.messageId,
      '这个话题的会话已经关闭，请新开一个话题继续。',
      hasThread,
    )
    return true
  }
  if (!isNew && session.status === 'creating') {
    await bot.reply(
      msg.messageId,
      '当前会话正在准备，请稍后再追问。',
      hasThread,
    )
    return true
  }
  if (session.status === 'active') {
    await bot.reply(
      msg.messageId,
      '当前会话还在执行，请等任务结束后再追问。',
      hasThread,
    )
    return true
  }

  return false
}

async function downloadImgOrFiles(options: StartBotMessage) {
  const { msg, bot, resolved } = options

  const resources = extractResourceKeys(msg.messageType, msg.rawContent)
  const downloadedFiles: string[] = []
  for (const res of resources) {
    try {
      const savePath = await bot.downloadResource(
        msg.messageId,
        res.key,
        res.type,
        join('data', 'downloads'),
        res.fileName,
      )
      const absPath = resolve(savePath)
      downloadedFiles.push(absPath)
      console.log(`  [下载] ${res.type} → ${absPath}`)
    } catch (e) {
      console.error(`  [下载失败] ${res.key}:`, (e as Error).message)
    }
  }

  return downloadedFiles
}

async function setBotStatusToIdle(
  run: AbortController,
  options: StartBotMessage,
) {
  const { session } = options

  if (activeRuns.get(session.id)?.controller === run)
    activeRuns.delete(session.id)
  try {
    await markSessionIdle(session.id)
  } catch (error) {
    console.error('[会话] 保存空闲状态失败:', (error as Error).message)
  }
}

//#endregion

// ——————————————————————————————————— 主进程 —————————————————————————————————————————————————

startBot({
  appId,
  appSecret,
  onCardAction: async (action) => {
    if (action.value.action !== 'abort_task') return undefined
    const sessionId =
      typeof action.value.sessionId === 'string' ? action.value.sessionId : ''
    const outcome = requestTaskAbort(
      activeRuns,
      sessionId,
      action.operatorOpenId,
    )
    if (outcome === 'not_found') {
      return {
        toast: { type: 'info', content: '任务已经结束，无需再次停止。' },
      }
    }
    if (outcome === 'forbidden') {
      return {
        toast: { type: 'warning', content: '只有任务发起人可以停止它。' },
      }
    }
    if (outcome === 'already_stopping') {
      return { toast: { type: 'info', content: '正在停止任务，请稍候。' } }
    }
    return { toast: { type: 'success', content: '已发送停止指令。' } }
  },
  onMessage: async (msg, bot) => {
    const resolved = resolveMentions(msg.text, msg.mentions)
    const hasThread = !!msg.threadId || !!msg.rootId
    const { session, isNew } = await sessions.resolve(msg)

    const startMessage = { msg, bot, resolved, hasThread, session, isNew }

    // 打印程序启动时的信息
    consoleStartMessage(startMessage)

    //#region 命令判断

    const command = parseCommand(resolved)
    if (await handleCommand(command, startMessage)) {
      return
    }

    //#endregion

    //#region 状态判断

    if (await handleStatus(startMessage)) {
      return
    }

    //#endregion

    await sessions.transition(session.id, 'active')
    const run = new AbortController()
    // 存入当前对话的任务控制信息
    const activeRun: ActiveRun = {
      controller: run,
      ownerOpenId: msg.senderOpenId,
    }
    activeRuns.set(session.id, activeRun)

    //#region 图片/文件下载

    const downloadedFiles = await downloadImgOrFiles(startMessage)

    let promptText = resolved
    if (downloadedFiles.length > 0) {
      promptText +=
        `\n\n【用户上传的附件/图片】\n` +
        downloadedFiles.map((p) => `- ${p}`).join('\n') +
        `\n请直接从上述本地路径读取并分析。`
    }

    //#endregion

    // 先回复一张卡片，后续更新复用同一个 message_id。
    let cardId: string | undefined
    try {
      cardId = await bot.replyCard(
        msg.messageId,
        buildTaskCard({
          title: 'Claude Code 任务',
          status: 'running',
          detail: '正在理解任务',
        }),
        hasThread,
      )
    } catch (error) {
      await setBotStatusToIdle(run, startMessage)
      throw error
    }

    if (!cardId) {
      console.error('[卡片] 响应里没有 message_id，无法继续更新')
      await setBotStatusToIdle(run, startMessage)
      return
    }

    console.log(`[卡片] 已发送 message_id=${cardId} inThread=${hasThread}`)

    // 用于初始化一轮任务的计时及会话展示信息，工具列表和计数使用字段的初始值
    const progress = new TaskProgressTracker(
      Date.now,
      contextWindows.get(session.id),
      !session.cliSessionId,
    )
    // 用于合并卡片进度
    const cardUpdater = new ThrottledCardUpdater((card) =>
      bot.updateCard(cardId, card),
    )
    const renderProgress = () => {
      const snapshot = progress.snapshot()
      cardUpdater.push(
        buildTaskCard({
          title: 'Claude Code',
          status: 'running',
          detail: snapshot.current,
          progress: snapshot,
          abortSessionId: session.id,
        }),
      )
    }
    // 每隔一秒发送一次卡片更新
    const progressHeartbeat = setInterval(renderProgress, 1_000)
    progressHeartbeat.unref()

    void executeCli(promptText, session.cliSessionId, run.signal, (event) => {
      if (
        event.type !== 'tool_start' &&
        event.type !== 'tool_end' &&
        event.type !== 'context'
      )
        return

      // 更新状态
      progress.accept(event)
      // 将新的状态渲染到卡片上
      renderProgress()
    })
      .then(async (result) => {
        clearInterval(progressHeartbeat)
        // 如果是新的 cli 会话，则保存这个会话 id
        if (result.sessionId && result.sessionId !== session.cliSessionId) {
          await sessions.setCliSessionId(session.id, result.sessionId)
        }
        // 存储上下文窗口的大小
        if (result.stats?.contextWindowTokens) {
          contextWindows.set(session.id, result.stats.contextWindowTokens)
        }

        const snapshot = progress.snapshot()
        await cardUpdater.finish(
          buildTaskCard({
            title: 'Claude Code',
            status: 'success',
            detail: '执行完成',
            progress: snapshot,
            answer: result.answer,
            stats: result.stats,
            recipientOpenId: msg.senderOpenId,
          }),
        )

        // cli 返回的结果太长，就切分分批返回飞书
        if (answerNeedsContinuation(result.answer)) {
          for (const chunk of splitLongText(
            answerContinuation(result.answer),
          )) {
            await bot.reply(msg.messageId, chunk, hasThread)
          }
        }
        console.log(`[CLI] 完成 session_id=${result.sessionId ?? '(无)'}`)
      })
      .catch(async (error) => {
        clearInterval(progressHeartbeat)

        if (run.signal.aborted) {
          console.log('[CLI] 任务已取消')
          await cardUpdater.finish(
            buildTaskCard({
              title: 'Claude Code',
              status: 'cancelled',
              detail:
                activeRun.cancelMode === 'close'
                  ? '本次任务已停止，当前会话已经关闭。'
                  : '本次任务已停止。你可以继续在当前话题里提问。',
              progress: progress.snapshot(),
            }),
          )
          return
        }

        const message = (error as Error).message
        console.error('[CLI] 执行失败:', message)
        await cardUpdater.finish(
          buildTaskCard({
            title: 'Claude Code',
            status: 'failed',
            detail: '执行没有完成。你可以调整指令后，在当前话题里重试。',
            technicalDetail: message,
            progress: progress.snapshot(),
          }),
        )
      })
      .finally(async () => {
        clearInterval(progressHeartbeat)
        await setBotStatusToIdle(run, startMessage)
      })
      .catch((error) => {
        console.error('[任务] 回传或收尾失败:', (error as Error).message)
      })
  },
})
