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
import { buildTaskCard } from './im/card.js'
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

//#endregion

//#region cli runner

function executeCli(
  prompt: string,
  sessionId: string | undefined,
  signal: AbortSignal,
) {
  return runCli({
    adapter: cliAdapter,
    prompt,
    cwd: cliWorkdir,
    sessionId,
    signal,
  })
}

//#endregion

//#region Abort

const activeRuns = new Map<string, AbortController>()

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
function markSessionIdle(sessionId: string): void {
  if (sessions.get(sessionId)?.status !== 'active') return
  sessions.transition(sessionId, 'idle')
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
    activeRuns.get(session.id)?.abort()
    if (session.status !== 'closed') sessions.transition(session.id, 'closed')
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

  false
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

  if (activeRuns.get(session.id) === run) activeRuns.delete(session.id)
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

    sessions.transition(session.id, 'active')
    const run = new AbortController()
    activeRuns.set(session.id, run)

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
          progress: 0,
          detail: '正在启动执行引擎',
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

    void executeCli(resolved, session.cliSessionId, run.signal)
      .then(async (result) => {
        if (result.sessionId && result.sessionId !== session.cliSessionId) {
          await sessions.setCliSessionId(session.id, result.sessionId)
        }

        await bot.updateCard(
          cardId,
          buildTaskCard({
            title: 'Claude Code 任务',
            status: 'success',
            progress: 100,
            detail: '执行完成',
          }),
        )
        await bot.reply(msg.messageId, result.answer, hasThread)
        console.log(`[CLI] 完成 session_id=${result.sessionId ?? '(无)'}`)
      })
      .catch(async (error) => {
        if (run.signal.aborted) {
          console.log('[CLI] 任务已取消')
          return
        }
        const message = (error as Error).message
        console.error('[CLI] 执行失败:', message)
        await bot.updateCard(
          cardId,
          buildTaskCard({
            title: 'Claude Code 任务',
            status: 'failed',
            progress: 0,
            detail: message,
          }),
        )
        await bot.reply(
          msg.messageId,
          `Claude Code 执行失败：${message}`,
          hasThread,
        )
      })
      .finally(async () => {
        await setBotStatusToIdle(run, startMessage)
      })
      .catch((error) => {
        console.error('[任务] 回传或收尾失败:', (error as Error).message)
      })
  },
})
