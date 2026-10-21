/**
 * Agent OS 入口。
 * 当前阶段：连上飞书，收到消息原样回一句（echo bot）。
 */
import 'dotenv/config'
import { join } from 'node:path'
import { buildTaskCard, ThrottledCardUpdater } from './im/card.js'
import { startBot, type Bot } from './im/lark.js'
import { extractResourceKeys, resolveMentions } from './im/message-parser.js'

const appId = process.env.BOT_A_APP_ID
const appSecret = process.env.BOT_A_APP_SECRET

if (!appId || !appSecret) {
  console.error('缺少 BOT_A_APP_ID / BOT_A_APP_SECRET，请检查 .env')
  process.exit(1)
}

console.log('Agent OS 启动，正在建立飞书长连接…')

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const DEMO_STEPS = [
  '读取项目结构',
  '定位任务入口',
  '分析相关文件',
  '生成修改方案',
  '写入代码改动',
  '检查类型错误',
  '运行验证命令',
  '整理执行结果',
]

async function runCardDemo(
  bot: Bot,
  cardId: string,
  resolved: string,
): Promise<void> {
  const activities: string[] = []
  const updater = new ThrottledCardUpdater(async (card) => {
    await bot.updateCard(cardId, card)
    console.log('[卡片] 已刷新')
  })

  for (const [index, step] of DEMO_STEPS.entries()) {
    await wait(700)
    activities.push(step)
    const progress = Math.round(((index + 1) / DEMO_STEPS.length) * 90)
    console.log(`[进度] ${progress}% ${step}`)
    updater.push(
      buildTaskCard({
        title: 'Agent OS 模拟任务',
        status: 'running',
        progress,
        detail: step,
        activities: activities.slice(-3),
      }),
    )
  }

  await updater.finish(
    buildTaskCard({
      title: 'Agent OS 模拟任务',
      status: 'success',
      progress: 100,
      detail: `已处理：${resolved || '富媒体消息'}`,
      activities: activities.slice(-3),
    }),
  )
  console.log('[卡片] 任务完成')
}

startBot({
  appId,
  appSecret,
  onMessage: async (msg, bot) => {
    const resolved = resolveMentions(msg.text, msg.mentions)
    console.log(`  原文: ${msg.text}`)
    console.log(`  还原: ${resolved}`)
    console.log(
      `  mentions: ${msg.mentions.map((m) => `${m.key}=${m.name}(${m.openId})`).join(', ') || '(无)'}`,
    )

    // 图片/文件下载
    const resources = extractResourceKeys(msg.messageType, msg.rawContent)
    for (const res of resources) {
      try {
        const savePath = await bot.downloadResource(
          msg.messageId,
          res.key,
          res.type,
          join('data', 'downloads'),
          res.fileName,
        )
        console.log(`  [下载] ${res.type} → ${savePath}`)
      } catch (e) {
        console.error(`  [下载失败] ${res.key}:`, (e as Error).message)
      }
    }

    const hasThread = !!msg.threadId || !!msg.rootId
    // const replyId = await bot.reply(
    //   msg.messageId,
    //   `收到：${resolved}`,
    //   hasThread,
    // )
    // console.log(`[已回] message_id=${replyId} inThread=${hasThread}`)

    const cardId = await bot.replyCard(
      msg.messageId,
      buildTaskCard({
        title: 'Agent OS 模拟任务',
        status: 'running',
        progress: 0,
        detail: '正在准备任务环境',
      }),
      hasThread,
    )

    if (!cardId) {
      console.error('[卡片] 响应里没有 message_id，无法继续更新')
      return
    }

    console.log(`[卡片] 已发送 message_id=${cardId} inThread=${hasThread}`)

    // 让事件回调尽快返回，后续模拟更新在后台继续。
    void runCardDemo(bot, cardId, resolved).catch((error) => {
      console.error('[卡片] 演示失败:', (error as Error).message)
    })
  },
})
