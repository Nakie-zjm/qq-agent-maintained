// 私聊必回：兜底判定的单测（纯函数，不用起 app）。
//
// 覆盖的是"搬运正文前该不该搬"这条最容易出事故的判断：
//   · 成稿 → 原样拆条搬出去（10-26 / 10-27 / 11-10 那几条真实正文）
//   · 内心戏 / 计划腔 → 不搬（10-26 群聊那条"我安静待着就行"、候选稿）
// 以及拆条规则（空行分段、短行兜底、上限、去重）。
import assert from 'node:assert/strict';
import {
  isPrivateChat,
  looksLikePlanningText,
  looksLikeInnerThought,
  splitReplyForFallback,
  PRIVATE_NUDGE
} from '../src/private-reply.js';

const pass = [], fail = [];
async function check(name, fn) {
  try { await fn(); pass.push(name); console.log(`  ✓ ${name}`); }
  catch (e) { fail.push(name); console.error(`  ✗ ${name}\n      ${e.message}`); }
}

console.log('private-reply');

await check('私聊判定只看 chatKey 前缀', () => {
  assert.equal(isPrivateChat('private:3212617914'), true);
  assert.equal(isPrivateChat('group:123456'), false);
  assert.equal(isPrivateChat(''), false);
  assert.equal(isPrivateChat(null), false);
});

await check('真实成稿：空行分段 → 两条', () => {
  // 2026-11-10 17:00 被丢掉的那句
  assert.deepEqual(
    splitReplyForFallback('腿已经让开了，过来枕\n\n慢点，别撞上来'),
    ['腿已经让开了，过来枕', '慢点，别撞上来']
  );
  // 2026-10-26 19:02
  assert.deepEqual(
    splitReplyForFallback('还来？行吧，我认输，你这表情包打法我确实拦不住(¬_¬)'),
    ['还来？行吧，我认输，你这表情包打法我确实拦不住(¬_¬)']
  );
  // 2026-10-27 13:08：两句连着，按空行切开而不是按句号乱切
  assert.deepEqual(
    splitReplyForFallback('我可不帮你示范歪的。\n\n行吧，歪就歪，我挑一句说，你可别嫌太软：今天别学温柔了，先吃点东西。'),
    ['我可不帮你示范歪的。', '行吧，歪就歪，我挑一句说，你可别嫌太软：今天别学温柔了，先吃点东西。']
  );
});

await check('只有单换行、每行都短 → 按行拆', () => {
  assert.deepEqual(splitReplyForFallback('嗯\n手给我'), ['嗯', '手给我']);
});

await check('单换行但有一行很长 → 保持一段，不硬拆', () => {
  const long = '我想说的是，今天下午那件事其实没有那么严重，你不用一直想着它。'.repeat(5); // > 120 字
  assert.deepEqual(splitReplyForFallback(`我在\n${long}`), [`我在\n${long}`]);
});

await check('超长单条才截断，且截到 300 字', () => {
  const one = '啊'.repeat(400);
  const out = splitReplyForFallback(one);
  assert.equal(out.length, 1);
  assert.equal(out[0].length, 300);
});

await check('最多 3 条，重复段去重，空文本返回空数组', () => {
  assert.deepEqual(splitReplyForFallback('一\n\n二\n\n三\n\n四').length, 3);
  assert.deepEqual(splitReplyForFallback('在的\n\n在的'), ['在的']);
  assert.deepEqual(splitReplyForFallback('   \n\n  '), []);
  assert.deepEqual(splitReplyForFallback(null), []);
});

await check('内心戏不搬（会误发给人）', () => {
  assert.equal(looksLikeInnerThought('不关我的事，这句话也不是冲着我来的，我安静待着就行喵。'), true);
  assert.equal(looksLikeInnerThought('（被禁言了，发不出去，安静待着）'), true);
  assert.equal(looksLikeInnerThought('嗯，手给我'), false);
  assert.equal(looksLikeInnerThought('腿已经让开了，过来枕'), false);
});

await check('计划腔/候选稿不搬', () => {
  assert.equal(looksLikePlanningText('可以回："在的"，或者"咋了" → 太冷淡'), true);
  assert.equal(looksLikePlanningText('候选一：在的\n候选二：怎么了'), true);
  assert.equal(looksLikePlanningText('1. 先问他吃没吃\n2. 再说别的'), true);
  assert.equal(looksLikePlanningText('腿已经让开了，过来枕'), false);
  assert.equal(looksLikePlanningText(''), false);
});

await check('提醒语本身是"私聊 + 必须发"的口径', () => {
  assert.match(PRIVATE_NUDGE, /私聊/);
  assert.match(PRIVATE_NUDGE, /send_message/);
  assert.match(PRIVATE_NUDGE, /至少一条/);
});

console.log(`\n通过 ${pass.length} 项，失败 ${fail.length} 项`);
if (fail.length) {
  console.error('失败：', fail.join(' / '));
  process.exit(1);
}
