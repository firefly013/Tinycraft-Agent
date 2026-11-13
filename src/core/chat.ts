/**
 * 聊天判级：身体只如实转发"有人说了什么"，这里决定"要不要叫模型、叫多大声"。
 *
 * 基线只有玩家，没有队友/profile，所以规则比旧项目少：
 *   - 服务器/命令回执（Teleported/Set time/Applied effect…）不投递，避免刷上下文；
 *   - 玩家说的话统一 → L3，带 expectReply；不做“急停词 L4”的启发式；
 *   - 私聊同样处理，文本里注明；
 *   - 同一人 60 秒内一字不差重复超过 3 次 → 丢掉（批量工具/宏会这样刷屏）。
 */

export interface ChatInput {
  username: string;
  message: string;
  whitelist?: boolean;
  selfName: string;
  whisper?: boolean;
  /** 同一个人同一句话在窗口内已经出现过几次（不含当前这条）。 */
  repeatCount?: number;
}

export interface ChatDecision {
  /** 2 只记录，3 唤醒，4 抢占。 */
  level: 2 | 3 | 4;
  addressed: boolean;
  expectReply: boolean;
  /** 给模型看的正文。 */
  text: string;
  /** true = 这条直接丢掉，不进上下文。 */
  drop?: boolean;
}

export const CHAT_REPEAT_WINDOW_MS = 60_000;
export const CHAT_REPEAT_MAX = 3;

/** 服务器/指令回执的已知前缀。这些不是"有人在跟你说话"。 */
const COMMAND_FEEDBACK_PREFIXES: readonly string[] = [
  'teleported ',
  'set the time to',
  'applied effect',
  'successfully filled',
  'game mode',
  'changed the game mode',
  'set own game mode',
  'gave ',
  'enchant',
  'summoned ',
  'setblock',
  'the entity was ',
  'no entity was found',
  'invalid player',
  'unknown or incomplete command',
];

export function isCommandFeedback(message: string): boolean {
  const lower = message.toLowerCase();
  return COMMAND_FEEDBACK_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function classifyChat(input: ChatInput): ChatDecision {
  const { username, message, selfName } = input;
  const whisper = input.whisper === true;

  // 批量工具/宏刷屏：一字不差重复太多次，直接丢。
  if ((input.repeatCount ?? 0) >= CHAT_REPEAT_MAX) {
    return { level: 2, addressed: false, expectReply: false, text: message, drop: true };
  }
  // 服务器回执不是聊天，不投递（避免把 "Teleported …" 当玩家说话叫醒模型）。
  if (!whisper && isCommandFeedback(message)) {
    return { level: 2, addressed: false, expectReply: false, text: message, drop: true };
  }

  const lower = message.toLowerCase();
  const addressed = whisper || lower.includes(selfName.toLowerCase());
  const where = whisper ? '（这是私聊，别人听不到）' : '';
  const ask = addressed ? `（消息里点了你的名字）` : '';
  const text =
    `玩家 ${username} 对你说：${message}${where}${ask}\n` +
    `**有人在直接跟你说话，先用一句文字回应（会自动进公聊），再继续手上的活。**`;

  return {
    level: 3,
    addressed: true,
    expectReply: true,
    text,
  };
}
