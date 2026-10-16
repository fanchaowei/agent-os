/**
 * Agent OS 入口。
 * 当前阶段：连上飞书，收到消息原样回一句（echo bot）。
 */
import 'dotenv/config'
import { startBot } from './im/lark.js'

const appId = process.env.BOT_A_APP_ID
const appSecret = process.env.BOT_A_APP_SECRET

if (!appId || !appSecret) {
  console.error('缺少 BOT_A_APP_ID / BOT_A_APP_SECRET，请检查 .env')
  process.exit(1)
}

console.log('Agent OS 启动，正在建立飞书长连接…')

startBot({
  appId,
  appSecret,
  onMessage: async (msg, bot) => {
    console.log(
      `[收到] chat=${msg.chatId} type=${msg.chatType} sender=${msg.senderOpenId} 内容: ${msg.text}`,
    )
    const replyId = await bot.reply(
      msg.messageId,
      `<at user_id="${process.env.OWNER_OPEN_ID}"></at> 收到，这条是点名回复`,
    )
    console.log(`[已回] message_id=${replyId}`)
  },
})
