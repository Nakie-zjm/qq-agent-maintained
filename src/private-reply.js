// 私聊必回：把"私聊里她一句话都没发出去"这件事，在代码层面堵死。
//
// ── 为什么需要这个模块 ────────────────────────────────────────────────────
// 群聊里"这轮不说话"是正常选项：档位与参与度本来就在算"这条值不值得接"。
// 私聊里不是 —— 对方看不到"她想了想又没说"，只看到"已读不回"。
// 实测（443 次运行）：7 次模型把回复写进了正文、没调 send_message。正文按设计
// 不发 QQ，于是整轮静默，落到 noreply。这 7 次里有 4 次发生在私聊。
//
// ── 这里只放纯函数 ────────────────────────────────────────────────────────
// 真正的补发动作留在 orchestrator（走统一发送链路：限频/去重/存档/状态机都在那里）。
// 本文件不 import 任何东西，测试可以直接驱动，不需要起整个 app。
//
// ── 判错的代价 ────────────────────────────────────────────────────────────
// 直接搬运正文的风险是把"内心戏"发给真人。所以搬运前先排除两类：
//   · 计划腔/候选稿（"可以回…或者…→ 太长"）——任何一句单独看都像成品，整段不能发
//   · 自我旁白（"不关我的事…我安静待着就行"）——那是思考，不是要说的话
// 排除掉的不硬发，交给"提醒模型重说一遍"和"强制补发"两条后续路径。

export const PRIVATE_PREFIX = 'private:';

/** 会话 key 是不是私聊（约定：`private:<QQ号>`）。 */
export function isPrivateChat(chatKey) {
  return String(chatKey || '').startsWith(PRIVATE_PREFIX);
}

/**
 * 私聊补发提醒：模型把话写在正文里、一个字没发出去时，注入一次。
 * 用 user 角色而不是 system —— 追加在 assistant 消息之后，是合法序列，
 * 也最贴近"对方在等"的现场感。
 */
export const PRIVATE_NUDGE = [
  '【系统提醒】这是私聊，对方在等你的回复。',
  '你刚才把要说的话写在了正文里 —— 正文不会发到 QQ，对方什么都没收到。',
  '现在直接用 send_message 发至少一条（要分条就传数组）；没什么可说也回一句短的。',
  '不要复述本条提醒，也不要解释。'
].join('');

// 计划腔：模型在正文里比较几个备选说法时，整段都不能当成品发。
const PLANNING_PATTERNS = [
  /(?:^|\n)\s*(?:候选|备选|方案|思路|做法)[一二三四五\d]*\s*[：:]/,
  /→/,
  /(?:或者|要么)[\s\S]{0,40}(?:或者|要么)/,
  /(?:可以|不如)(?:这么|这样)?(?:回|说|写)\s*[：:]/,
  /(?:^|\n)\s*\d+\s*[.、)]\s*/,
  /(?:太长|太短|换个说法|重新说)/
];

/** 正文是不是"比较候选/计划"腔（这类不能当成品发）。 */
export function looksLikePlanningText(text) {
  const body = String(text ?? '').trim();
  if (!body) return false;
  return PLANNING_PATTERNS.some((re) => re.test(body));
}

// 自我旁白：观察/判断/决定不说，不是要说给对方的话。
const INNER_THOUGHT_PATTERNS = [
  /不关我的事/,
  /我(?:就)?安静(?:待着|看着|等)/,
  /(?:发不出去|被禁言)/,
  /这句(?:话)?(?:也)?不是冲/,
  /我不(?:说|回)话/,
  /还是别(?:说|回)了/
];

/** 正文是不是"自我旁白"（内心戏）。 */
export function looksLikeInnerThought(text) {
  const body = String(text ?? '').trim();
  if (!body) return false;
  return INNER_THOUGHT_PATTERNS.some((re) => re.test(body));
}

/**
 * 把正文拆成可以直接交给 send_message 的多条消息。
 *
 * 只做"切分"，绝不改写：模型的正文本身就是成品时，原样搬出去比重新生成更安全
 * （重新生成会换措辞，等于替她说话）。
 *
 * 分段规则：
 *   1. 优先按空行切（她的习惯就是一条消息一段，段间空一行）
 *   2. 全文只有一段、但内部有换行且每行都很短 → 按行切（防止把两条挤成一条）
 *   3. 单条超过 maxChars（QQ 上没有意义的长段）才截断
 *
 * @param {string} text 模型写在本轮正文里的内容
 * @param {{maxMessages?:number, maxChars?:number}} [opts]
 * @returns {string[]} 待发送的消息；[] 表示没有可搬的内容
 */
export function splitReplyForFallback(text, { maxMessages = 3, maxChars = 300 } = {}) {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!raw) return [];

  let parts = raw.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 1 && parts[0].includes('\n')) {
    const lines = parts[0].split('\n').map((s) => s.trim()).filter(Boolean);
    if (lines.length > 1 && lines.every((l) => l.length <= 120)) parts = lines;
  }

  const out = [];
  for (const part of parts) {
    if (out.length >= Math.max(1, maxMessages)) break;
    const clipped = part.length > maxChars ? part.slice(0, maxChars) : part;
    if (clipped && !out.includes(clipped)) out.push(clipped);
  }
  return out;
}
