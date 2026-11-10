// 私聊必回：端到端回归（mock OneBot + mock LLM，真起 app）。
//
// 承诺：**有人私聊找她时，这一轮必须有一条消息发出去**，不许落到 noreply。
// 覆盖三条兜底路径 + 两条"不该动"的边界：
//   A 正文就是成稿      → 原句搬出去（不额外请求）
//   B 正文为空          → 提醒一轮，让她自己用工具说
//   C 整轮只调 finish   → 循环结束后强制补发
//   D 正文是内心戏      → 不搬（不能把内心戏发给人），改走提醒
//   E 群聊              → 保持原样：这轮不说话是正常选项，不许被私聊逻辑污染
//
// 运行：node test/private-reply-e2e.mjs
import assert from 'node:assert/strict';
import { bootApp } from './_harness.mjs';

const pass = [], fail = [];
async function check(name, fn) {
  try { await fn(); pass.push(name); console.log(`  ✓ ${name}`); }
  catch (e) { fail.push(name); console.error(`  ✗ ${name}\n      ${e.message}`); }
}

const env = await bootApp({});
let seq = 7000;

function nextMid() { seq += 1; return seq; }

function pushPrivate(text) {
  env.onebotWs.push({
    post_type: 'message', message_type: 'private', user_id: 777, self_id: 888,
    message_id: nextMid(), time: Math.floor(Date.now() / 1000),
    sender: { user_id: 777, nickname: '冰鱼' },
    message: [{ type: 'text', data: { text } }]
  });
}

function textOf(send) {
  const msg = send?.body?.message;
  if (Array.isArray(msg)) return msg.filter((s) => s.type === 'text').map((s) => s.data?.text ?? '').join('');
  return String(msg ?? '');
}

/** 跑一个场景：推消息 → 等会话结束 → 返回 { session, sends, requests }。 */
async function scenario({ trigger, push, script }) {
  env.llm.state.script.push(...script);
  const sentBefore = env.onebotHttp.state.sends.length;
  const reqBefore = env.llm.state.requests.length;
  push();
  const session = await env.waitSessionDone(trigger, 12000);
  return {
    session,
    status: session.status,
    sends: env.onebotHttp.state.sends.slice(sentBefore).map(textOf),
    requests: env.llm.state.requests.length - reqBefore,
    firstRequest: env.llm.state.requests[reqBefore] || null
  };
}

/** 取某次请求里用户消息的文本（可能是 string，也可能是 parts 数组）。 */
function userPromptOf(request) {
  const msg = (request?.messages || []).find((m) => m.role === 'user');
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  return (msg.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
}

console.log('private-reply e2e');

// A. 正文就是成稿 → 原句补发，不再问模型一轮。
await check('A 私聊成稿被丢掉 → 原句补发（两条）', async () => {
  const r = await scenario({
    trigger: '我要膝枕',
    push: () => pushPrivate('我要膝枕'),
    script: [{ content: '腿已经让开了，过来枕\n\n慢点，别撞上来' }]
  });
  assert.equal(r.status, 'done', `会话状态应为 done，实际 ${r.status}`);
  assert.deepEqual(r.sends, ['腿已经让开了，过来枕', '慢点，别撞上来']);
  assert.equal(r.requests, 1, `补发不该再问模型：请求数 ${r.requests}`);
  assert.equal(r.session.finishReason, '私聊兜底：正文原句补发');
  // 提示词层面也兑现承诺：私聊有硬规则、没有"不回是正常选项"。
  const prompt = userPromptOf(r.firstRequest);
  assert.match(prompt, /【私聊规则（硬性）】/);
  assert.match(prompt, /本轮必须用 send_message 发出至少一条/);
  assert.doesNotMatch(prompt, /不回是正常选项/);
});

// B. 正文为空（模型想了半天什么都没写）→ 提醒一轮，模型补发。
await check('B 私聊空正文 → 提醒后补发', async () => {
  const r = await scenario({
    trigger: '今天过得怎么样',
    push: () => pushPrivate('今天过得怎么样'),
    script: [
      { content: '' },
      { toolCalls: [{ name: 'send_message', args: { messages: ['还行，就是下午有点闲'] } }] },
      { content: '（收尾）' }
    ]
  });
  assert.equal(r.status, 'done', `会话状态应为 done，实际 ${r.status}`);
  assert.deepEqual(r.sends, ['还行，就是下午有点闲']);
  assert.ok(r.requests >= 2, `至少要有"提醒"那一轮，请求数 ${r.requests}`);
});

// C. 整轮只调 finish（"我不说"）→ 收尾强制补发。
await check('C 私聊只调 finish → 强制补发', async () => {
  const r = await scenario({
    trigger: '在吗',
    push: () => pushPrivate('在吗'),
    script: [
      { toolCalls: [{ name: 'finish', args: { reason: '不想说话' } }] },
      { toolCalls: [{ name: 'send_message', args: { messages: ['在'] } }] }
    ]
  });
  assert.equal(r.status, 'done', `会话状态应为 done，实际 ${r.status}`);
  assert.deepEqual(r.sends, ['在']);
  assert.equal(r.session.finishReason, '私聊兜底：强制补发一条');
});

// D. 正文是内心戏 → 不许搬（会把"我安静待着就行"发给人），改走提醒。
await check('D 私聊内心戏不同搬，改提醒后补发', async () => {
  const r = await scenario({
    trigger: '我想去城头',
    push: () => pushPrivate('我想去城头'),
    script: [
      { content: '不关我的事，这句话也不是冲着我的，我安静待着就行喵。' },
      { toolCalls: [{ name: 'send_message', args: { messages: ['城头有什么好看的'] } }] },
      { content: '（收尾）' }
    ]
  });
  assert.equal(r.status, 'done');
  assert.deepEqual(r.sends, ['城头有什么好看的'], `内心戏不能发给对方，实际发出：${JSON.stringify(r.sends)}`);
});

// F. 连强制补发都失败（接口异常/模型死活不发）→ 不许留"未回复"的假象：标 error，可重试。
await check('F 兜底彻底失败 → 标 error 而不是 noreply', async () => {
  const r = await scenario({
    trigger: '睡了吗',
    push: () => pushPrivate('睡了吗'),
    script: [
      { content: '不关我的事，我安静待着就行喵。' },   // 内心戏 → 不搬
      { content: '（还是别说了）' },                    // 提醒后仍是内心戏 → 不搬
      { content: '（强制轮1，仍不发）' },               // 强制轮：没有 tool_call
      { content: '（强制轮2，仍不发）' }
    ]
  });
  assert.equal(r.status, 'error', `兜底失败应标 error（可重试），实际 ${r.status}`);
  assert.deepEqual(r.sends, []);
  assert.match(String(r.session.error || ''), /私聊兜底失败/);
});

// E. 群聊保持原样：正文没人搬，这轮可以不说话。
await check('E 群聊不套私聊兜底', async () => {
  env.llm.state.script.push({ content: '（只是想想，不说话）' });
  const sentBefore = env.onebotHttp.state.sends.length;
  const reqBefore = env.llm.state.requests.length;
  env.onebotWs.push({
    post_type: 'message', message_type: 'group', group_id: 456, user_id: 222, self_id: 888,
    message_id: nextMid(), time: Math.floor(Date.now() / 1000),
    sender: { user_id: 222, card: '群友222', nickname: '群友222' },
    message: [{ type: 'text', data: { text: '今天天气不错' } }]
  });
  const session = await env.waitSessionDone('今天天气不错', 12000);
  assert.equal(session.status, 'noreply', `群聊应当允许沉默，实际 ${session.status}`);
  assert.deepEqual(env.onebotHttp.state.sends.slice(sentBefore).map(textOf), []);
  // 群聊的提示词保持原样：没有私聊硬规则，仍保留"不回是正常选项"。
  const prompt = userPromptOf(env.llm.state.requests[reqBefore]);
  assert.doesNotMatch(prompt, /【私聊规则（硬性）】/);
  assert.match(prompt, /不回是正常选项/);
});

await env.teardown();
console.log(`\n通过 ${pass.length} 项，失败 ${fail.length} 项`);
if (fail.length) {
  console.error('失败：', fail.join(' / '));
  process.exit(1);
}
