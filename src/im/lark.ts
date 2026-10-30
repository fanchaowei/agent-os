/**
 * 飞书接入层：通过 WebSocket 长连接接收消息和卡片交互，通过 REST API 回复消息、更新卡片及下载资源。
 * startBot 先创建客户端与机器人实例，再注册事件处理函数并启动长连接；
 * 收到事件后，将飞书原始数据转换为业务层使用的结构，再交给调用方提供的回调处理。
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
  /** 根消息 ID，用于关联同一话题内的消息；事件未提供时使用空字符串。 */
  rootId: string
  /** 消息所属的话题 ID，与会话标识 chatId 区分；事件未提供时使用空字符串。 */
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
  /**
   * 可选的卡片交互回调；不传入时忽略卡片交互事件。
   * @param action 解析后的操作者、卡片消息 ID 和操作数据。
   * @returns 返回给飞书的提示或卡片内容；undefined 表示不提供这些响应内容。
   */
  onCardAction?: (action: CardAction) => Promise<CardActionResponse | undefined>
}

/** 业务层使用的卡片交互数据，屏蔽飞书原始事件字段路径的差异。 */
export interface CardAction {
  /** 触发交互的用户 open_id；原始事件未提供时使用空字符串。 */
  operatorOpenId: string
  /** 被操作的卡片消息 ID；可用于后续更新卡片，缺失时使用空字符串。 */
  messageId: string
  /** 卡片交互组件携带的自定义数据，供业务层判断要执行的操作。 */
  value: Record<string, unknown>
}

/** 卡片交互回调的响应结构，可只返回提示、只返回卡片，或同时返回两者。 */
export interface CardActionResponse {
  /** 展示给操作者的即时提示。 */
  toast?: {
    /** 提示级别，决定成功、信息、警告或错误的展示样式。 */
    type: 'success' | 'info' | 'warning' | 'error'
    /** 提示正文。 */
    content: string
  }
  /** 通过交互响应返回的卡片更新内容。 */
  card?: {
    /** raw 表示直接提供卡片 JSON。 */
    type: 'raw'
    /** 更新后要展示的卡片结构。 */
    data: CardJson
  }
}

/**
 * 将原始卡片交互事件转换成业务层的 CardAction。
 * 操作者与消息 ID 分别兼容两种字段路径；缺失时使用空字符串，操作数据不是非空对象时使用空对象。
 * @param data SDK 传入的原始卡片交互事件。
 * @returns 统一字段命名并带有默认值的交互数据。
 */
export function parseCardAction(data: any): CardAction {
  /** 组件携带的原始操作数据，先保留为原值，再通过 isRecord 检查。 */
  const value = data?.action?.value
  return {
    operatorOpenId: data?.operator?.open_id ?? data?.operator_id?.open_id ?? '',
    messageId: data?.context?.open_message_id ?? data?.open_message_id ?? '',
    value: isRecord(value) ? value : {},
  }
}

/** 暴露给业务层的机器人能力：SDK 客户端、文本与卡片回复、卡片更新及资源下载。 */
export interface Bot {
  /** 飞书 REST API 客户端，用于调用发消息、上传图片等开放接口。 */
  client: Lark.Client
  /**
   * 向指定消息回复文本，并返回新消息的标识；响应中缺少标识时返回 undefined。
   * @param messageId 被回复的原消息标识。
   * @param text 回复的纯文本正文。
   * @param replyInThread 是否以话题内回复的方式发送；省略时为 false。
   */
  reply: (
    messageId: string,
    text: string,
    replyInThread?: boolean,
  ) => Promise<string | undefined>
  /**
   * 将卡片结构序列化为 JSON，以交互卡片消息的形式回复原消息。
   * @param messageId 被回复的原消息 ID。
   * @param card 要发送的卡片结构。
   * @param replyInThread 是否在话题内回复；省略时为 false。
   * @returns 新卡片消息的 ID；响应未携带时返回 undefined。
   */
  replyCard: (
    messageId: string,
    card: CardJson,
    replyInThread?: boolean,
  ) => Promise<string | undefined>
  /**
   * 将新的卡片结构序列化后，通过消息更新接口替换已有卡片内容。
   * @param messageId 要更新的卡片消息 ID。
   * @param card 更新后的卡片结构。
   * @returns 更新请求完成后兑现的 Promise。
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

/**
 * 从下载响应头中读取指定字段：优先调用 get，否则按传入名称及其小写形式读取对象属性。
 * 字段值为数组时只取第一项；缺失时返回空字符串。
 * @param headers SDK 返回的响应头对象。
 * @param name 要读取的响应头名称。
 * @returns 读取到的字段值，或空字符串。
 */
function getHeader(headers: any, name: string): string {
  /** 尚未统一数组形态的响应头字段值。 */
  const value =
    typeof headers?.get === 'function'
      ? headers.get(name)
      : (headers?.[name] ?? headers?.[name.toLowerCase()])
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

/**
 * 推断下载资源的扩展名，优先采用原文件名，其次根据 Content-Type 查表，最后使用 img/bin 兜底。
 * @param type 资源类别，决定无法识别时的兜底扩展名。
 * @param fileName 可选的原文件名；仅接受 1 至 10 位字母或数字组成的扩展名。
 * @param contentType 下载响应中的 MIME 类型，可带分号分隔的参数。
 * @returns 不包含点号的小写扩展名。
 */
function resourceExtension(
  type: 'image' | 'file',
  fileName: string | undefined,
  contentType: string,
): string {
  /** 从原文件名提取并去掉点号的扩展名；没有文件名时为空字符串。 */
  const original = fileName ? extname(fileName).slice(1).toLowerCase() : ''
  if (/^[a-z0-9]{1,10}$/.test(original)) return original

  /** 去除 charset 等附加参数、首尾空白并转为小写后的 MIME 类型。 */
  const mime = contentType.split(';', 1)[0].trim().toLowerCase()
  return CONTENT_TYPE_EXTENSIONS[mime] ?? (type === 'image' ? 'img' : 'bin')
}

/** 富文本消息中的单个元素，仅声明提取纯文本时会用到的字段。 */
interface PostElement {
  /** 元素类别，如 text、at、br、a 或 code_block。 */
  tag?: string
  /** 文本、链接或代码等元素携带的正文。 */
  text?: string
  /** @ 元素指向的用户标识；提取时保留标识，不转换为显示名。 */
  user_id?: string
}

/**
 * 将一个富文本元素转为字符串：@ 元素取用户标识，br 转换为换行，文本类元素取正文，其他元素忽略。
 * @param element 当前要转换的富文本元素。
 * @returns 该元素对应的纯文本片段。
 */
function renderPostElement(element: PostElement): string {
  if (element.tag === 'at') return element.user_id ?? ''
  if (element.tag === 'br') return '\n'
  if (['text', 'a', 'code', 'code_block', 'md'].includes(element.tag ?? '')) {
    return element.text ?? ''
  }
  return ''
}

/**
 * 从消息 content 中提取纯文本：text 直接取正文，post 按段落拼接各元素，其他类型返回空字符串。
 * 富文本会过滤空段落、用换行连接剩余段落并去除整体首尾空白；非法 JSON 会直接抛出解析异常。
 * @param messageType 飞书消息类型。
 * @param content 原始消息内容的 JSON 字符串。
 * @returns 提取出的正文。
 */
export function extractMessageText(
  messageType: string,
  content: string,
): string {
  /** 反序列化后的消息内容，具体字段由 messageType 决定。 */
  const parsed = JSON.parse(content)
  if (messageType === 'text') {
    return parsed.text ?? ''
  }
  if (messageType === 'post') {
    /** 富文本的二维元素数组：外层为段落，内层为该段落包含的元素。 */
    const paragraphs: PostElement[][] = parsed.content ?? []
    return paragraphs
      // paragraph 是当前段落；先把各元素转换为字符串，再拼成一段正文。
      .map((paragraph) => paragraph.map(renderPostElement).join(''))
      .filter(Boolean)
      .join('\n')
      .trim()
  }
  return ''
}

/**
 * 创建机器人并启动事件接收流程：初始化 REST 客户端、封装业务方法、注册事件，再启动 WebSocket。
 * 普通消息转换为 IncomingMessage 后交给 onMessage；卡片交互转换后交给可选的 onCardAction。
 * @param opts 应用凭证与业务回调；凭证由调用方从环境配置中读取。
 * @returns 业务可用的机器人实例；返回时不代表 WebSocket 已建立连接。
 */
export function startBot(opts: BotOptions): Bot {
  /** appId、appSecret 用于客户端鉴权；onMessage、onCardAction 分别处理消息和卡片交互。 */
  const { appId, appSecret, onMessage, onCardAction } = opts

  /** REST 客户端，负责主动调用飞书 API 并管理鉴权 token。 */
  const client = new Lark.Client({ appId, appSecret })

  /** 业务层共用的机器人实例，也会随普通消息传给 onMessage 回调。 */
  const bot: Bot = {
    client,

    /**
     * 将正文编码为 JSON，调用回复接口，再从响应中提取新消息 ID。
     * @param messageId 被回复的消息 ID。
     * @param text 要发送的纯文本。
     * @param replyInThread 是否在话题内回复，默认 false。
     * @returns 新消息 ID；响应缺失该字段时为 undefined。
     */
    async reply(messageId, text, replyInThread = false) {
      /** 回复接口返回的结果，data 中可能包含新消息 ID。 */
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

    /**
     * 将卡片编码为 JSON，以 interactive 类型调用回复接口，并提取新消息 ID。
     * @param messageId 被回复的消息 ID。
     * @param card 要发送的卡片结构。
     * @param replyInThread 是否在话题内回复，默认 false。
     * @returns 新卡片消息 ID；响应缺失该字段时为 undefined。
     */
    async replyCard(messageId, card, replyInThread = false) {
      /** 卡片回复接口返回的结果，用于取得新创建的消息 ID。 */
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

    /**
     * 将卡片结构序列化后调用 patch 接口，等待已有卡片内容更新完成。
     * @param messageId 要更新的卡片消息 ID。
     * @param card 更新后的卡片结构。
     */
    async updateCard(messageId, card) {
      await client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      })
    },

    /**
     * 从消息资源接口获取下载响应，根据文件名或 MIME 推断后缀，创建目录并写入文件。
     * @param messageId 资源所属的消息 ID，必须与 fileKey 对应。
     * @param fileKey 消息内容里的 image_key 或 file_key。
     * @param type 资源类别：image 或 file。
     * @param saveDir 本地保存目录，不存在时递归创建。
     * @param fileName 可选的原文件名，用于优先保留扩展名。
     * @returns 实际保存的文件路径。
     */
    async downloadResource(messageId, fileKey, type, saveDir, fileName) {
      /** SDK 下载响应，包含响应头以及将内容写入本地文件的 writeFile 方法。 */
      const res = await client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type },
      })
      /** 响应声明的 MIME 类型，供无原始扩展名时推断文件格式。 */
      const contentType = getHeader(res.headers, 'content-type')
      /** 最终采用的扩展名，不包含点号。 */
      const extension = resourceExtension(type, fileName, contentType)
      /** 使用资源 key 和扩展名生成的本地目标路径。 */
      const savePath = join(saveDir, `${fileKey}.${extension}`)
      await mkdir(saveDir, { recursive: true })
      await res.writeFile(savePath)
      return savePath
    },
  }

  /** 按事件名称分发 WebSocket 收到的数据，分别处理卡片交互与普通消息。 */
  const dispatcher = new Lark.EventDispatcher({}).register({
    /**
     * 解析卡片交互并返回业务回调的响应；没有配置回调时直接忽略。
     * @param data SDK 传入的原始卡片交互事件。
     * @returns 业务层生成的提示或卡片响应，也可能为 undefined。
     */
    'card.action.trigger': async (data: any) => {
      if (!onCardAction) return undefined
      return onCardAction(parseCardAction(data))
    },
    /**
     * 将飞书原始消息映射为统一结构，提取正文和 @ 信息，再等待业务回调完成。
     * @param data SDK 传入的消息接收事件，包含消息与发送者数据。
     */
    'im.message.receive_v1': async (data) => {
      /** 原始消息对象，字段使用飞书 API 的下划线命名。 */
      const m = data.message
      /** 转换后的业务消息；缺失的根消息、话题和发送者标识使用空字符串。 */
      const msg: IncomingMessage = {
        messageId: m.message_id,
        chatId: m.chat_id,
        chatType: m.chat_type,
        messageType: m.message_type,
        text: extractMessageText(m.message_type, m.content),
        rootId: m.root_id ?? '',
        threadId: m.thread_id ?? '',
        senderOpenId: data.sender.sender_id?.open_id ?? '',
        mentions: parseMentions(m.mentions),
        rawContent: m.content,
      }
      await onMessage(msg, bot)
    },
  })

  /** 使用同一组应用凭证建立并维护长连接的客户端，收到事件后交给 dispatcher。 */
  const wsClient = new Lark.WSClient({ appId, appSecret })
  wsClient.start({ eventDispatcher: dispatcher })

  return bot
}

/**
 * 检查值是否为非 null 的对象，并通过类型谓词让 TypeScript 在判断成功后收窄其类型。
 * 这里只做基础检查，数组等对象也会通过；不会验证是否为普通对象或检查内部字段。
 * @param value 待检查的未知值。
 * @returns typeof 为 object 且不为 null 时返回 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
