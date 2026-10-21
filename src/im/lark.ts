/**
 * 飞书接入层：通过 WebSocket 长连接接收消息，通过 REST API 回复消息。
 * 启动时创建 API 客户端、注册事件处理函数并开启长连接；收到消息后，
 * 提取正文并转换为业务层统一使用的 IncomingMessage，再交给 onMessage 处理。
 */
import * as Lark from '@larksuiteoapi/node-sdk'
import { mkdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { CardJson } from './card.js'
import { parseMentions, type Mention } from './message-parser.js'

/** 将飞书消息事件中业务需要的字段集中到一个对象，避免业务层依赖完整的 SDK 事件结构。 */
export interface IncomingMessage {
  /** 当前消息的唯一标识；回复消息时需要将它传给 bot.reply。 */
  messageId: string
  /** 消息所属会话的标识，用于区分不同的单聊或群聊。 */
  chatId: string
  /** 会话类型，例如 'p2p' 表示单聊，'group' 表示群聊。 */
  chatType: string
  /** 飞书原始消息类型，例如 'text'（文本）、'image'（图片）、'post'（富文本）。 */
  messageType: string
  /** 从文本或富文本消息中提取的纯文本；其他消息类型返回空字符串。 */
  text: string
  /** 发送者在当前应用下的 open_id；事件未提供该字段时使用空字符串。 */
  senderOpenId: string
  /** 属于哪个话题的 id */
  rootId: string
  /** 话题群本身的 id */
  threadId: string
  /** 本条消息中所有 @提及（含机器人自己）的结构化数据，由 parseMentions() 从事件的 mentions 数组提取。 */
  mentions: Mention[]
  /** 消息原始 content 字段（JSON 字符串），用于提取 image_key / file_key 等资源。 */
  rawContent: string
}

/** 启动机器人需要的应用凭证，以及接收到消息时要执行的业务回调。 */
export interface BotOptions {
  /** 飞书应用的 App ID，由调用方从环境配置中读取并传入。 */
  appId: string
  /** 飞书应用的 App Secret，由调用方从环境配置中读取并传入。 */
  appSecret: string
  /**
   * 异步处理收到的消息；事件处理函数会等待此回调执行结束。
   * @param msg 已转换的消息，包含会话、发送者和提取后的正文。
   * @param bot 当前机器人实例，供业务层回复消息或调用其他飞书 API。
   */
  onMessage: (msg: IncomingMessage, bot: Bot) => Promise<void>
}

/** 暴露给业务层的机器人能力：可直接使用 SDK 客户端，也可使用封装好的文本回复方法。 */
export interface Bot {
  /** 飞书 REST API 客户端，用于调用发消息、上传图片等开放接口。 */
  client: Lark.Client
  /**
   * 向指定消息回复文本，并返回新消息的标识；响应中缺少标识时返回 undefined。
   * @param messageId 被回复的原消息标识。
   * @param text 回复的纯文本正文。
   * @param replyInThread
   */
  reply: (
    messageId: string,
    text: string,
    replyInThread?: boolean,
  ) => Promise<string | undefined>
  /**
   * 回复卡片
   * @param messageId
   * @param card
   * @param replyInThread
   * @returns
   */
  replyCard: (
    messageId: string,
    card: CardJson,
    replyInThread?: boolean,
  ) => Promise<string | undefined>
  /**
   * 更新卡片
   * @param messageId
   * @param card
   * @returns
   */
  updateCard: (messageId: string, card: CardJson) => Promise<void>
  /**
   * 下载消息中的图片或文件资源到本地目录。
   * @param messageId 资源所属的消息 ID
   * @param fileKey   资源 key（image_key 或 file_key）
   * @param type      资源类型，"image" 或 "file"
   * @param saveDir   保存目录（不存在会自动递归创建）
   * @param fileName  原文件名（可选，用于保留扩展名；图片会按响应 Content-Type 推断）
   * @returns         实际保存到本地的文件路径
   */
  downloadResource: (
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
    saveDir: string,
    fileName?: string,
  ) => Promise<string>
}

// MIME 类型 → 文件扩展名的对照表。
// 图片消息本身不带文件名，下载时只能靠响应头里的 Content-Type 反推扩展名，就靠这张表。
const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
}

// 用于从响应头里读取一个字段的值，兼容三种形态：
// 有 .get() 方法的 Headers 对象、字段名大小写不固定的普通对象、值为数组的情况。
function getHeader(headers: any, name: string): string {
  const value =
    typeof headers?.get === 'function'
      ? headers.get(name)
      : (headers?.[name] ?? headers?.[name.toLowerCase()])
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

// 给下载下来的资源定一个扩展名，优先级：原文件名 > Content-Type > 兜底值。
// 文件消息通常有原文件名，直接沿用；图片消息没有文件名，就从 Content-Type 推；
// 都推不出来时，图片给 "img"，文件给 "bin"，保证落地文件总有个后缀。
function resourceExtension(
  type: 'image' | 'file',
  fileName: string | undefined,
  contentType: string,
): string {
  const original = fileName ? extname(fileName).slice(1).toLowerCase() : ''
  if (/^[a-z0-9]{1,10}$/.test(original)) return original

  const mime = contentType.split(';', 1)[0].trim().toLowerCase()
  return CONTENT_TYPE_EXTENSIONS[mime] ?? (type === 'image' ? 'img' : 'bin')
}

/**
 * 将飞书消息的 JSON 内容解析为纯文本，供业务层统一处理。
 * 普通文本直接读取 text；富文本展开各段并拼接文本节点，忽略图片、链接等其他节点。
 * 富文本提取不会保留段落分隔，并会去掉结果首尾的空白；其他消息类型返回空字符串。
 *
 * @param messageType 飞书消息类型，用于选择正文提取方式。
 * @param content 飞书事件中的 JSON 字符串；解析失败时异常会向调用方传播。
 * @returns 提取出的文本正文。
 */
function extractText(messageType: string, content: string): string {
  // 解析消息内容，后续按消息类型读取对应字段。
  const parsed = JSON.parse(content)
  if (messageType === 'text') {
    return parsed.text ?? ''
  }
  if (messageType === 'post') {
    // 富文本正文是二维节点数组：外层表示段落，内层表示段落中的文本、图片等节点。
    const paragraphs: any[][] = parsed.content ?? []
    return (
      paragraphs
        .flat()
        // el 是展开后的单个富文本节点；仅保留 tag 为 text 的节点。
        .filter((el) => el.tag === 'text')
        // el 是筛选后的文本节点；取出正文并在后续拼接为一个字符串。
        .map((el) => el.text)
        .join('')
        .trim()
    )
  }
  return ''
}

/**
 * 创建机器人并启动飞书消息接收流程。
 * 先创建用于发送请求的 REST 客户端和业务可用的 bot 对象，再注册消息事件处理函数，
 * 最后启动 WebSocket 长连接。事件处理函数负责转换消息，并等待业务回调处理完毕。
 *
 * @param opts 应用凭证与消息处理回调。
 * @returns 可用于回复消息的机器人实例；返回时不代表长连接已建立完成。
 */
export function startBot(opts: BotOptions): Bot {
  // appId、appSecret 用于初始化两个 SDK 客户端；onMessage 负责执行外部传入的业务逻辑。
  const { appId, appSecret, onMessage } = opts

  // REST 客户端负责主动调用飞书 API，并根据应用凭证管理鉴权 token。
  const client = new Lark.Client({ appId, appSecret })

  // 业务层共用的机器人实例，也会随收到的消息一起传入 onMessage 回调。
  const bot: Bot = {
    client,
    /**
     * 将文本序列化成飞书要求的 JSON 内容，调用回复接口，再提取新消息的标识。
     * @param messageId 被回复的原消息标识，放入请求路径参数。
     * @param text 回复正文，编码后放入请求体的 content 字段。
     * @returns 回复消息的标识；响应未携带标识时返回 undefined。
     */
    async reply(messageId, text, replyInThread = false) {
      // 回复接口的响应，data 中包含新创建的消息信息。
      const res = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text }),
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      })
      return res.data?.message_id
    },
    async replyCard(messageId, card, replyInThread = false) {
      const res = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify(card),
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      })
      return res.data?.message_id
    },
    async updateCard(messageId, card) {
      await client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      })
    },
    /**
     * 把一条消息里的图片/文件资源下载到本地，返回保存路径。
     *
     * @param messageId 消息 ID，和 fileKey 必须来自同一条消息，否则飞书会报错
     * @param fileKey   资源 key，即 content 里的 image_key 或 file_key
     * @param type      'image' 或 'file'，飞书接口靠它区分资源类型
     * @param saveDir   保存目录，不存在会自动创建
     * @param fileName  可选，文件消息用它保留原扩展名；图片一般不用传
     */
    async downloadResource(messageId, fileKey, type, saveDir, fileName) {
      // 1. 向飞书要这个资源，拿到的是响应（带着 headers 和一个 writeFile 方法），不是直接的内存字节
      const res = await client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type },
      })

      // 2. 从响应头读 content-type，如 "image/jpeg"
      const contentType = getHeader(res.headers, 'content-type')

      // 3. 推断扩展名：文件消息优先用原文件名后缀，图片看 MIME 映射，都没有就兜底 img/bin
      const extension = resourceExtension(type, fileName, contentType)

      // 4. 拼出落盘路径：<saveDir>/<fileKey>.<ext>
      const savePath = join(saveDir, `${fileKey}.${extension}`)

      // 5. 递归建目录（目录已存在也不会报错）
      await mkdir(saveDir, { recursive: true })

      // 6. 把响应内容写进文件，SDK 提供的便捷方法
      await res.writeFile(savePath)

      // 7. 返回实际路径，方便调用方记日志或后续读取
      return savePath
    },
  }

  // 事件分发器按事件名称调用对应处理函数；此处只注册接收消息事件。
  const dispatcher = new Lark.EventDispatcher({}).register({
    /**
     * 将原始消息事件转换为业务消息，再交给启动时传入的回调处理。
     * @param data SDK 传入的接收消息事件，包含消息内容和发送者信息。
     */
    'im.message.receive_v1': async (data) => {
      // 飞书原始消息对象，字段沿用开放平台的下划线命名。
      const m = data.message
      // 转换后的业务消息：统一字段命名、提取正文，并为缺失的发送者标识设置默认值。
      const msg: IncomingMessage = {
        messageId: m.message_id,
        chatId: m.chat_id,
        chatType: m.chat_type,
        messageType: m.message_type,
        text: extractText(m.message_type, m.content),
        senderOpenId: data.sender.sender_id?.open_id ?? '',
        rootId: m.root_id ?? '',
        threadId: m.thread_id ?? '',
        mentions: parseMentions(m.mentions),
        rawContent: m.content,
      }
      await onMessage(msg, bot)
    },
  })

  // WebSocket 客户端使用同一组凭证建立并维护长连接，收到的事件交给 dispatcher 分发。
  const wsClient = new Lark.WSClient({ appId, appSecret })
  wsClient.start({ eventDispatcher: dispatcher })

  return bot
}
