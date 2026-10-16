/**
 * 飞书接入：WS 长连接收消息 + REST 回消息。
 */
import * as Lark from '@larksuiteoapi/node-sdk'

export interface IncomingMessage {
  messageId: string
  chatId: string
  chatType: string // 'p2p' 单聊 | 'group' 群聊
  messageType: string // 'text' | 'image' | 'post' | ...
  text: string // text 消息的正文（其他类型为空串）
  senderOpenId: string
}

export interface BotOptions {
  appId: string
  appSecret: string
  onMessage: (msg: IncomingMessage, bot: Bot) => Promise<void>
}

export interface Bot {
  client: Lark.Client
  reply: (messageId: string, text: string) => Promise<string | undefined>
}

function extractText(messageType: string, content: string): string {
  const parsed = JSON.parse(content)
  if (messageType === 'text') {
    return parsed.text ?? ''
  }
  if (messageType === 'post') {
    const paragraphs: any[][] = parsed.content ?? []
    return paragraphs
      .flat()
      .filter((el) => el.tag === 'text')
      .map((el) => el.text)
      .join('')
      .trim()
  }
  return ''
}

export function startBot(opts: BotOptions): Bot {
  const { appId, appSecret, onMessage } = opts

  // Lark.Client 管出，所有主动调 API 的动作——发消息、回消息、以后的传图片、改卡片都走它。它拿着 App ID 和 Secret 自己维护鉴权 token，你不用操心过期刷新。
  const client = new Lark.Client({ appId, appSecret })

  const bot: Bot = {
    client,
    async reply(messageId, text) {
      const res = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: { msg_type: 'text', content: JSON.stringify({ text }) },
      })
      return res.data?.message_id
    },
  }

  // EventDispatcher 管分发。长连接上下来的事件五花八门，dispatcher 按事件名路由到对应的处理函数。
  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      const m = data.message
      const msg: IncomingMessage = {
        messageId: m.message_id,
        chatId: m.chat_id,
        chatType: m.chat_type,
        messageType: m.message_type,
        text: extractText(m.message_type, m.content),
        senderOpenId: data.sender.sender_id?.open_id ?? '',
      }
      await onMessage(msg, bot)
    },
  })

  // Lark.WSClient 负责建立并维持那条 WebSocket 长连接，断了自动重连。
  const wsClient = new Lark.WSClient({ appId, appSecret })
  wsClient.start({ eventDispatcher: dispatcher })

  return bot
}
