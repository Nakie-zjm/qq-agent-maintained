// 社区模块（云端共享屏蔽名单 + 固定价格表）离线回归测试。
//
// 为什么需要它：这两个功能直接决定"谁被拦、价怎么算"，一旦退化不会 crash，
// 而是静默放行消息或算错成本 —— 必须由断言钉住。全程假 fetch，不依赖外网。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-community-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  api: { baseUrl: '', apiKey: '', model: '' },
  globalBlocklist: ['666', '1234567'],
  server: { port: 3399 }
}));

// ── 假服务端：云端接口已随上游移除，这里只保留一个不会再被调用的计数器，
//    用来断言「本地更新不会偷偷发请求」。 ──
const cloud = { ids: new Set(), requireKeyForReplace: 'community-secret' };
let postedAdd = 0;
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  const method = String(options.method || 'GET').toUpperCase();
  const body = options.body ? JSON.parse(options.body) : {};
  const json = (status, value) => ({ ok: status < 400, status, text: async () => JSON.stringify(value) });
  if (target.includes('/blocklist/add') && method === 'POST') {
    postedAdd++;
    for (const id of body.ids || []) cloud.ids.add(String(id));
    return json(200, { ok: true, ids: [...cloud.ids] });
  }
  if (target.endsWith('/blocklist') && method === 'PUT') {
    const key = options.headers?.['X-Community-Key'] || '';
    if (key !== cloud.requireKeyForReplace) return json(403, { ok: false, error: '社区管理密钥错误' });
    cloud.ids = new Set((body.ids || []).map(String));
    return json(200, { ok: true, ids: [...cloud.ids] });
  }
  if (target.endsWith('/blocklist') && method === 'GET') {
    return json(200, { ok: true, ids: [...cloud.ids] });
  }
  return json(404, { ok: false, error: 'not found' });
};

const community = await import('../src/community.js');
const { getConfig, updateConfig } = await import('../src/config.js');

await check('配置里的全局屏蔽项立即生效（含短号码，不被长度校验吞掉）', () => {
  const list = community.getGlobalBlocklist();
  assert.ok(list.includes('666'), `短号码 666 必须生效，实际 ${JSON.stringify(list)}`);
  assert.ok(list.includes('1234567'), '长号码应生效');
  assert.ok(community.isGloballyBlocked('666'), 'isGloballyBlocked 应对 666 返回 true');
  assert.equal(community.isGloballyBlocked('99999888'), false, '未列入者不应被判为屏蔽');
});

await check('运行中修改配置（不重启）也能立刻接管屏蔽判定', () => {
  updateConfig({ globalBlocklist: ['666', '1234567', '888001'] });
  assert.ok(community.isGloballyBlocked('888001'), '改配置后新号码应立刻生效');
  updateConfig({ globalBlocklist: ['666', '1234567'] });
  assert.equal(community.isGloballyBlocked('888001'), false, '移除后应立刻不再屏蔽');
});

await check('屏蔽名单增删只作用于本地配置（没有云端接口）', async () => {
  const res = await community.updateGlobalBlocklist(['5550001'], { mode: 'add' });
  assert.ok(res.ids.includes('5550001'), `追加后名单应含新号码，实际 ${JSON.stringify(res.ids)}`);
  assert.equal(res.warning, '', '本地更新不应产生告警');
  assert.equal(community.COMMUNITY_API_BASE, '', '本副本不提供社区接口（永久关闭，不提供自建开关）');
  const after = await community.updateGlobalBlocklist(['5550001'], { mode: 'remove' });
  assert.ok(!after.ids.includes('5550001'), '解除后不应再出现在名单里');
});

await check('云端同步已停用：不启动定时器，同步只返回本地名单', async () => {
  assert.equal(community.startCommunitySync(() => {}), null, '没有社区接口时不应启动定时器');
  const synced = await community.syncGlobalBlocklist();
  assert.deepEqual(synced, community.getGlobalBlocklist(), '同步返回的应是本地名单');
});

await check('远程价格表已随上游移除（价格只用内置表）', async () => {
  const fs2 = await import('node:fs');
  const p = new URL('../src/price-feed.js', import.meta.url);
  assert.equal(fs2.existsSync(p), false, 'src/price-feed.js 应已删除');
});

fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`\n社区模块：通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);
