// 「模型配置」换提供商时 API Key 必须跟着换（2026-10-31 回归）
//
// 现象：两个提供商都配了同名模型 deepseek-flash。在「模型配置」里改选另一个
// 提供商的模型后，Base URL 变了、API Key 还是上一个提供商的：
//   · 点过「显示」时肉眼可见还是旧 Key；
//   · 「显示 / 清除 / 测试连通性 / 保存」也都还对着旧提供商操作 —— 输入的新 Key
//     会被存到**旧**提供商身上（旧 Key 被悄悄换掉，新提供商反而没有 Key）。
//
// 根因：这些处理器都用打开弹窗时快照的 c.api.provider，而「选择模型」只改了
// Base URL 和隐藏字段 #mc-picked。修法是统一按"表单实际指向的提供商"取。
//
// 用 jsdom 加载真实 ui/index.html + 12 段脚本，走一遍真实点击路径。
// 依赖 jsdom（可选）：npm i -D jsdom
//
// 运行：node test/model-switch-key-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, bootApp } from './_harness.mjs';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.log('\n⚠ 未安装 jsdom，跳过本套件。启用方式：npm i -D jsdom\n');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try {
    const extra = await fn();
    pass++;
    console.log(`  OK    ${name}${extra ? ` —— ${extra}` : ''}`);
  } catch (error) {
    fail++;
    console.log(`  FAIL  ${name}\n        -> ${String(error?.message ?? error)}`);
  }
};

// 两个提供商、同一个模型 id、两把不同的 Key —— 用户报的就是这个形态
const KEY_A = 'sk-deepseek-AAA';
const KEY_B = 'sk-apikeyfan-BBB';
const PROVIDER_A = {
  id: 'pa', displayName: 'api.deepseek.com', api: 'openai', anthropicOrigin: false,
  baseURL: 'https://api.deepseek.com', apiKey: '', apiKeyFrom: 'manual',
  models: ['deepseek-flash'], modelNames: {}, needsBaseUrl: false
};
const PROVIDER_B = {
  id: 'pb', displayName: 'api.apikey.fan', api: 'openai', anthropicOrigin: false,
  baseURL: 'https://api.apikey.fan/v1', apiKey: '', apiKeyFrom: 'manual',
  models: ['deepseek-flash'], modelNames: {}, needsBaseUrl: false
};

const ctx = await bootApp({
  config: {
    api: { provider: PROVIDER_A.id, model: 'deepseek-flash', baseUrl: PROVIDER_A.baseURL, apiKey: '' },
    providers: [PROVIDER_A, PROVIDER_B],
    dshProviderKeys: { [PROVIDER_A.id]: KEY_A, [PROVIDER_B.id]: KEY_B }
  }
});
const { base, teardown } = ctx;
const { getConfig } = await import('../src/config.js');

const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
let code = (await import('./_ui-load.mjs')).loadUiAppCode().code;
code = code.replace(/^'use strict';\s*$/m, '');
// eval 环境跑不了 export 前缀（07 段有一处），与浏览器里 window.eval 同款处理
code = code.replace(/^export\s+(function|const|let|async function|class)/gm, '$1');

const dom = new JSDOM(html, { url: base + '/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
window.fetch = (input, init) => fetch(new URL(String(input), base).href, init);
window.EventSource = class { constructor() {} addEventListener() {} close() {} };
window.alert = () => {};
window.confirm = () => true;
// jsdom 的 window 上没有 structuredClone（真实浏览器有），补等价垫片
if (typeof window.structuredClone !== 'function') {
  window.structuredClone = (v) => JSON.parse(JSON.stringify(v));
}
// ui/app 里用到的两个内置依赖（与 coverage-wiring 同款注入）
const tier = await import(pathToFileURL(path.join(ROOT, 'src', 'tier-slider.js')).href);
const priceMod = await import(pathToFileURL(path.join(ROOT, 'ui', 'vendor', 'price-match.js')).href);
window.TIER_SLIDER_BANDS = tier.TIER_SLIDER_BANDS;
window.sliderToTier = tier.sliderToTier;
window.tierToSlider = tier.tierToSlider;
window.matchPriceTable = priceMod.matchPriceTable;

window.eval(code);
await sleep(1500);

const doc = window.document;
const waitFor = async (label, fn, timeout = 6000) => {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - started > timeout) throw new Error(`等待超时：${label}`);
    await sleep(60);
  }
};
const modalByHead = (head) => [...doc.querySelectorAll('.model-modal')].find((m) => m.textContent.includes(head));

// 设置页是**懒渲染**的（切到该页签才 renderSettings），所以先点页签
await waitFor('设置页签', () => doc.querySelector('.tab[data-tab="settings"]'));
doc.querySelector('.tab[data-tab="settings"]').click();
await waitFor('设置页「模型配置」按钮', () => doc.querySelector('#open-model-config-btn'));
doc.querySelector('#open-model-config-btn').click();
const cfgModal = await waitFor('模型配置弹窗', () => modalByHead('模型配置'));
await waitFor('Base URL 回填', () => cfgModal.querySelector('#mc-baseurl')?.value);

// 复现用户的操作：先点「显示」把 A 的 Key 露出来，再去切提供商
await check('前置：打开「模型配置」点「显示」露出的当前提供商 A 的 Key', async () => {
  cfgModal.querySelector('#mc-apikey-toggle').click();
  await waitFor('读出 A 的 Key', () => cfgModal.querySelector('#mc-apikey').value === KEY_A);
  assert.equal(cfgModal.querySelector('#mc-apikey').type, 'text');
});

// 在「选择模型」里改选 B 的 deepseek-flash
cfgModal.querySelector('#mc-model-pick').click();
const picker = await waitFor('选择模型弹窗', () => modalByHead('选择模型'));
await waitFor('提供商列表', () => picker.querySelector('.mm-prov[data-pid="pb"]'));
picker.querySelector('.mm-prov[data-pid="pb"]').click();
await waitFor('B 的模型列表', () => picker.querySelector('.mm-model[data-model="deepseek-flash"]'));
picker.querySelector('.mm-model[data-model="deepseek-flash"]').click();
await sleep(120);

await check('切到 B 的模型后 Base URL 跟着变', async () => {
  assert.equal(cfgModal.querySelector('#mc-baseurl').value, PROVIDER_B.baseURL);
});

await check('切到 B 后 Key 框不再显示 A 的 Key（回到掩码）', async () => {
  const input = cfgModal.querySelector('#mc-apikey');
  assert.notEqual(input.value, KEY_A, 'Key 框仍在显示上一个提供商 A 的 Key');
  assert.equal(input.type, 'password');
  assert.equal(input.value, '******', 'B 有 Key，应显示掩码');
});

await check('切到 B 后 Key 标题标注的是 B（同名模型时靠它分辨归属）', async () => {
  assert.match(cfgModal.querySelector('#mc-apikey-owner').textContent, /api\.apikey\.fan/);
});

await check('切到 B 后点「显示」读的是 B 的 Key', async () => {
  cfgModal.querySelector('#mc-apikey-toggle').click();
  await waitFor('读出 B 的 Key', () => cfgModal.querySelector('#mc-apikey').value === KEY_B);
  assert.notEqual(cfgModal.querySelector('#mc-apikey').value, KEY_A);
});

await check('再点「隐藏」回到 B 的掩码（不会把 A 的 Key 又贴回来）', async () => {
  cfgModal.querySelector('#mc-apikey-toggle').click();
  const input = cfgModal.querySelector('#mc-apikey');
  assert.equal(input.type, 'password');
  assert.equal(input.value, '******');
});

await check('在 B 下输入新 Key 保存：存给 B，A 的 Key 不受影响', async () => {
  cfgModal.querySelector('#mc-apikey').value = 'sk-new-for-B';
  cfgModal.querySelector('#mc-save').click();
  await waitFor('配置落盘', () => getConfig().dshProviderKeys?.pb === 'sk-new-for-B', 8000);
  const cfg = getConfig();
  assert.equal(cfg.api?.provider, PROVIDER_B.id, '选中的提供商应切到 B');
  assert.equal(cfg.api?.model, 'deepseek-flash');
  assert.equal(cfg.api?.baseUrl, PROVIDER_B.baseURL);
  assert.equal(cfg.dshProviderKeys?.[PROVIDER_A.id], KEY_A, 'A 的 Key 被误改');
});

await teardown();
try { dom.window.close(); } catch { /* ignore */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
