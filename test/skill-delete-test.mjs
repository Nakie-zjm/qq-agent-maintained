// 删除技能/插件：磁盘安全边界单测 + DELETE /api/skills/:id 端到端集成。
//
// 背景：删除是后端**唯一会递归删除用户磁盘目录**的动作。安全边界写松一点，
// "删一个技能"就可能变成删整个 skills/、删仓库根，或者顺着符号链接删到根目录之外。
// 所以本测试分两层：
//   1. 单元：src/skills/delete-dir.js 的 resolveDeletableExtensionDir /
//      removeExtensionDir —— 覆盖所有拒绝分支，且证明"校验失败时磁盘不动"；
//   2. HTTP：DELETE /api/skills/:id 的完整业务流程 —— 返回契约、磁盘真的删掉、
//      配置残留一并清掉、插件不受影响、重复删除/不存在 404、reload 后不复活、
//      加载失败条目可删、路径校验失败 409。
//
// 隔离（hermetic）：skills/、plugins/、data/ 全部指向 os.tmpdir() 下的临时目录，
// 不读本机自装扩展、不碰真实 data/。⚠️ 环境变量必须在**任何 src/ 模块加载之前**设置：
// 本文件顶部只静态 import node: 内置模块（静态 import 会被提升到语句之前执行），
// src/ 与 _harness 一律在设置完 env 之后动态 import —— 否则 _isolate.mjs / 加载器
// 可能在 env 生效前就把真实 skills/、plugins/ 解析掉了。
//
// 运行：node test/skill-delete-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── 1. hermetic 环境（先设置，再 import 任何被测模块）──────────────────────
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-skill-delete-'));
const SKILLS_DIR = path.join(TMP_ROOT, 'skills');
const PLUGINS_DIR = path.join(TMP_ROOT, 'plugins');
const DATA_DIR = path.join(TMP_ROOT, 'data');
const UNIT_ROOT = path.join(TMP_ROOT, 'unit');
process.env.QQ_AGENT_SKILLS_DIR = SKILLS_DIR;
process.env.QQ_AGENT_PLUGINS_DIR = PLUGINS_DIR;
process.env.QQ_AGENT_DATA_DIR = DATA_DIR;
// 关掉"强制开启热重载"的开关：本测试会删除目录，watcher 若在后台重扫会与断言交叉。
delete process.env.QQ_AGENT_DEV;

const { createChecker, bootApp } = await import('./_harness.mjs');
const { resolveDeletableExtensionDir, removeExtensionDir } = await import('../src/skills/delete-dir.js');

// ── 工具函数 ─────────────────────────────────────────────────────────────
const c = createChecker('删除技能/插件（安全边界 + HTTP 集成）');
const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });
const writeText = (file, text) => { mkdirp(path.dirname(file)); fs.writeFileSync(file, text, 'utf8'); };
const writeJson = (file, obj) => writeText(file, JSON.stringify(obj, null, 2));
const exists = (p) => fs.existsSync(p);

/**
 * 写一个最小技能目录（skills/<id>/skill.json + index.js）。
 * 清单形状对齐真实扩展（plugins/kaomoji/plugin.json、skills/persona-stickers/skill.json）：
 * skill.json 必须能过 normalizeManifest，index.js 必须 setup(api) 且至少 registerTool。
 * 用 withIndex=false 造"加载失败"条目（有清单、缺入口）。
 */
function writeSkillDir(root, id, { withIndex = true } = {}) {
  const dir = path.join(root, id);
  writeJson(path.join(dir, 'skill.json'), {
    id,
    name: `集成测试技能 ${id}`,
    version: '0.0.1',
    apiVersion: 1,
    category: 'utility',
    description: '删除集成测试用的最小技能',
    entry: 'index.js',
    settings: { note: '默认备注' },
    configSchema: { note: { type: 'string', label: '备注', default: '默认备注' } }
  });
  if (withIndex) {
    writeText(path.join(dir, 'index.js'), [
      '// 最小技能：skills/ 是 LLM 型，必须 registerTool 才会进模型的工具列表。',
      'export function setup(api) {',
      '  api.registerTool({',
      "    id: 'echo',",
      "    name: '回显',",
      "    description: '删除集成测试用工具',",
      "    parameters: { type: 'object', properties: {} },",
      "    execute: async () => 'ok'",
      '  });',
      '}',
      ''
    ].join('\n'));
  }
  return dir;
}

/** 写一个最小插件目录（plugins/<id>/plugin.json + index.js）。 */
function writePluginDir(root, id) {
  const dir = path.join(root, id);
  writeJson(path.join(dir, 'plugin.json'), {
    id,
    name: `集成测试插件 ${id}`,
    version: '0.0.1',
    apiVersion: 1,
    category: 'utility',
    description: '删除集成测试用的最小插件',
    entry: 'index.js'
  });
  writeText(path.join(dir, 'index.js'), [
    '// 最小插件：不提供能力/钩子，只验证"能被列出、且不被删技能误伤"。',
    'export function setup() {}',
    'export const hooks = {};',
    ''
  ].join('\n'));
  return dir;
}

// ── 2. 磁盘 fixture ──────────────────────────────────────────────────────
// 单元测试用独立根（unit/），绝不能用 SKILLS_DIR/PLUGINS_DIR —— 否则这些空目录/
// 坏文件会被 app 启动扫描当成真实扩展，污染 HTTP 段的列表断言。
const UNIT_SKILLS = path.join(UNIT_ROOT, 'skills');
const UNIT_PLUGINS = path.join(UNIT_ROOT, 'plugins');
const ROOTS = [UNIT_SKILLS, UNIT_PLUGINS];
mkdirp(path.join(UNIT_SKILLS, 'child-ok'));
mkdirp(path.join(UNIT_PLUGINS, 'plugin-ok'));
mkdirp(path.join(UNIT_SKILLS, 'deep', 'nested'));          // 二级嵌套
mkdirp(path.join(UNIT_ROOT, 'skills_backup', 'evil'));      // 同前缀陷阱（"skills_backup" 以 "skills" 开头）
mkdirp(path.join(TMP_ROOT, 'outside-dir'));                 // 根外目录
mkdirp(path.join(TMP_ROOT, 'outside-target'));              // 符号链接指向的目标
writeText(path.join(UNIT_SKILLS, 'plain.txt'), 'not a directory');

// app 启动扫描用的 fixture：必须在 bootApp **之前**写好。
mkdirp(SKILLS_DIR); mkdirp(PLUGINS_DIR); mkdirp(DATA_DIR);
const fixtures = {
  okSkillDir: writeSkillDir(SKILLS_DIR, 'ok-skill'),                       // 正常技能：走完整删除流程
  guardSkillDir: writeSkillDir(SKILLS_DIR, 'guard-skill'),                 // 正常技能：用于 HTTP 409 分支
  brokenSkillDir: writeSkillDir(SKILLS_DIR, 'broken-skill', { withIndex: false }), // 加载失败条目
  okPluginDir: writePluginDir(PLUGINS_DIR, 'ok-plugin')                    // 插件：证明"删技能不误伤插件"
};

// ═══════════════════════════════════════════════════════════════════════
// 1. 单元：resolveDeletableExtensionDir 安全边界
// ═══════════════════════════════════════════════════════════════════════
c.section('1. 单元：resolveDeletableExtensionDir 安全边界');

await c.check('合法「根的直接子目录」（skills）→ ok:true', () => {
  const r = resolveDeletableExtensionDir(path.join(UNIT_SKILLS, 'child-ok'), ROOTS);
  assert.equal(r.ok, true, '合法目录应允许删除');
  assert.equal(r.name, 'child-ok');
  assert.equal(r.root, path.resolve(UNIT_SKILLS), 'root 应是解析后的绝对路径');
  assert.equal(r.dir, path.resolve(UNIT_SKILLS, 'child-ok'));
});

await c.check('合法「根的直接子目录」（plugins，roots 传对象形式）→ ok:true', () => {
  const r = resolveDeletableExtensionDir(path.join(UNIT_PLUGINS, 'plugin-ok'),
    { skills: UNIT_SKILLS, plugins: UNIT_PLUGINS });
  assert.equal(r.ok, true, '插件根下的直接子目录应允许删除');
  assert.equal(r.root, path.resolve(UNIT_PLUGINS));
});

await c.check('根目录本身 → ok:false（root-itself，error 非空）', () => {
  for (const root of ROOTS) {
    const r = resolveDeletableExtensionDir(root, ROOTS);
    assert.equal(r.ok, false, `不能删除根目录本身：${root}`);
    assert.ok(String(r.error || '').length > 0, '应给出可读的拒绝原因');
    assert.equal(r.code, 'root-itself');
  }
});

await c.check('二级嵌套子目录 → ok:false（not-direct-child，error 非空）', () => {
  const r = resolveDeletableExtensionDir(path.join(UNIT_SKILLS, 'deep', 'nested'), ROOTS);
  assert.equal(r.ok, false, '只能删根的直接子目录');
  assert.ok(String(r.error || '').length > 0);
  assert.equal(r.code, 'not-direct-child');
});

await c.check('根外目录 → ok:false（outside-root，error 非空）', () => {
  const r = resolveDeletableExtensionDir(path.join(TMP_ROOT, 'outside-dir'), ROOTS);
  assert.equal(r.ok, false);
  assert.ok(String(r.error || '').length > 0);
  assert.equal(r.code, 'outside-root');
});

await c.check('同前缀目录（skills_backup/evil）→ ok:false（不能用 startsWith 判定）', () => {
  const r = resolveDeletableExtensionDir(path.join(UNIT_ROOT, 'skills_backup', 'evil'), ROOTS);
  assert.equal(r.ok, false, '"skills_backup" 不是 "skills" 根内的目录');
  assert.ok(String(r.error || '').length > 0);
  assert.equal(r.code, 'outside-root');
});

await c.check('不存在的路径 → ok:false（not-found，error 非空）', () => {
  const r = resolveDeletableExtensionDir(path.join(UNIT_SKILLS, 'no-such-dir'), ROOTS);
  assert.equal(r.ok, false);
  assert.ok(String(r.error || '').length > 0);
  assert.equal(r.code, 'not-found');
});

await c.check('非目录文件 → ok:false（not-directory，error 非空）', () => {
  const r = resolveDeletableExtensionDir(path.join(UNIT_SKILLS, 'plain.txt'), ROOTS);
  assert.equal(r.ok, false, '文件不能被当成目录删除');
  assert.ok(String(r.error || '').length > 0);
  assert.equal(r.code, 'not-directory');
});

await c.check('相对路径 → ok:false（relative-dir，避免按 cwd 误解析）', () => {
  const r = resolveDeletableExtensionDir(path.join('skills', 'child-ok'), ROOTS);
  assert.equal(r.ok, false);
  assert.ok(String(r.error || '').length > 0);
  assert.equal(r.code, 'relative-dir');
});

await c.check('空目标 / 没有可用根 → ok:false 且 error 非空', () => {
  const empty = resolveDeletableExtensionDir('', ROOTS);
  assert.equal(empty.ok, false);
  assert.ok(String(empty.error || '').length > 0);
  const noRoots = resolveDeletableExtensionDir(path.join(UNIT_SKILLS, 'child-ok'), []);
  assert.equal(noRoots.ok, false);
  assert.ok(String(noRoots.error || '').length > 0);
});

await c.check('符号链接 / junction 目录 → ok:false（Windows 无权限创建时 SKIP）', () => {
  // Windows 上创建 symlink 需要管理员/开发者模式；junction 通常普通用户可建。
  // 两种都失败就 SKIP（不算失败）—— 该断言在其他平台/有权限的机器上仍会真跑。
  const linkPath = path.join(UNIT_SKILLS, 'link-dir');
  const errors = [];
  let created = false;
  for (const type of (process.platform === 'win32' ? ['junction', 'dir'] : ['dir'])) {
    try {
      fs.symlinkSync(path.join(TMP_ROOT, 'outside-target'), linkPath, type);
      created = true;
      break;
    } catch (error) {
      errors.push(`${type}: ${error?.code || error?.message}`);
    }
  }
  if (!created) {
    console.log(`  SKIP  符号链接目录（本机无权限创建链接：${errors.join('；')}）`);
    return 'SKIP（无权限创建符号链接）';
  }
  try {
    const r = resolveDeletableExtensionDir(linkPath, ROOTS);
    assert.equal(r.ok, false, '符号链接/junction 必须拒绝，否则 rm 会顺着链接删到目标');
    assert.ok(String(r.error || '').length > 0);
    assert.equal(r.code, 'symlink');
  } finally {
    // 清理链接本身（不要递归，避免碰到目标目录）。
    try { fs.unlinkSync(linkPath); } catch { try { fs.rmdirSync(linkPath); } catch { /* 交给最终清理 */ } }
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 2. 单元：removeExtensionDir —— 校验通过才删，校验失败磁盘不动
// ═══════════════════════════════════════════════════════════════════════
c.section('2. 单元：removeExtensionDir（校验失败不动磁盘）');

await c.check('校验通过：递归删除整个目录', async () => {
  const dir = path.join(UNIT_SKILLS, 'rm-ok');
  mkdirp(path.join(dir, 'nested'));
  writeText(path.join(dir, 'nested', 'a.txt'), 'x');
  writeText(path.join(dir, 'root.txt'), 'y');
  const r = await removeExtensionDir(dir, ROOTS);
  assert.equal(r.ok, true);
  assert.equal(exists(dir), false, '校验通过后目录应被整个删掉');
});

await c.check('校验失败（根外）：返回 ok:false 且磁盘未动', async () => {
  const target = path.join(TMP_ROOT, 'outside-dir');
  const r = await removeExtensionDir(target, ROOTS);
  assert.equal(r.ok, false);
  assert.ok(String(r.error || '').length > 0);
  assert.equal(exists(target), true, '校验失败时不能碰磁盘');
});

await c.check('校验失败（根目录本身）：返回 ok:false 且根目录仍在', async () => {
  const r = await removeExtensionDir(UNIT_SKILLS, ROOTS);
  assert.equal(r.ok, false);
  assert.equal(exists(UNIT_SKILLS), true, '不能删除扩展根目录');
});

// ═══════════════════════════════════════════════════════════════════════
// 3. HTTP：DELETE /api/skills/:id 端到端
// ═══════════════════════════════════════════════════════════════════════
c.section('3. HTTP：DELETE /api/skills/:id 端到端');

let ctx = null;
try {
  ctx = await bootApp({
    config: {
      // 关掉热重载：本测试自己会删目录，不让后台 watcher 的重扫和断言抢时序。
      extensions: { hotReload: false },
      // 预置一条 config.skills：验证 DELETE 会清掉配置残留（removedConfig:true）。
      skills: { 'ok-skill': { enabled: true, note: '启动时写入的配置' } }
    }
  });
  const { request } = ctx;

  await c.check('GET /api/skills：列出技能 + 插件 + 加载失败条目（启动扫描）', async () => {
    const r = await request('GET', '/api/skills');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.skills), 'skills 应为数组');
    const byId = new Map(r.data.skills.map((s) => [s.id, s]));
    for (const id of ['ok-skill', 'guard-skill', 'broken-skill', 'ok-plugin']) {
      assert.ok(byId.has(id), `启动后应能列出 ${id}`);
    }
    assert.equal(byId.get('ok-skill').kind, 'skill');
    assert.equal(byId.get('ok-plugin').kind, 'plugin');
    assert.equal(byId.get('ok-skill').loaded, true);
    assert.equal(byId.get('ok-plugin').loaded, true);
    // 缺 index.js 的条目：以加载失败状态可见（带原因），而不是凭空消失
    assert.equal(byId.get('broken-skill').loaded, false);
    assert.ok(String(byId.get('broken-skill').loadError || '').length > 0, '加载失败条目应带 loadError');
    // 已安装的 ok-skill 不应出现在"已配置但未安装"列表里
    assert.equal((r.data.uninstalled || []).some((u) => u.id === 'ok-skill'), false);
  });

  await c.check('启动配置里的 config.skills[id] 已生效（GET /api/config 可见）', async () => {
    const r = await request('GET', '/api/config');
    assert.equal(r.status, 200);
    const cfg = r.data.skills?.['ok-skill'];
    assert.ok(cfg, 'config.skills 里应有 ok-skill');
    assert.equal(cfg.note, '启动时写入的配置');
  });

  await c.check('POST /api/skills/<id> 写入设置（造一条删除前的配置残留）', async () => {
    const r = await request('POST', '/api/skills/ok-skill', { body: { settings: { note: '删除前保存的备注' } } });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    const cfg = await request('GET', '/api/config');
    assert.equal(cfg.data.skills['ok-skill'].note, '删除前保存的备注', '设置应已落盘');
  });

  await c.check('DELETE /api/skills/<id>：200 且返回契约 { ok,id,dir,removedConfig,config }', async () => {
    const r = await request('DELETE', '/api/skills/ok-skill');
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.id, 'ok-skill');
    assert.equal(typeof r.data.dir, 'string');
    assert.ok(r.data.dir.length > 0, 'dir 应是非空字符串（仓库相对路径）');
    assert.ok(r.data.dir.includes('ok-skill'), `dir 应指向被删目录：${r.data.dir}`);
    assert.equal(r.data.removedConfig, true, '删除前配置里有该 id，removedConfig 应为 true');
    assert.ok(r.data.config && typeof r.data.config === 'object', '响应应带清理后的 config');
    assert.equal(Object.prototype.hasOwnProperty.call(r.data.config.skills || {}, 'ok-skill'), false,
      '响应 config 里不该再有该 id');
  });

  await c.check('DELETE 后：磁盘目录真的被递归删掉', () => {
    assert.equal(exists(fixtures.okSkillDir), false, 'skills/ok-skill 目录应消失');
  });

  await c.check('DELETE 后：GET /api/skills 不再含它，残留列表也没有', async () => {
    const r = await request('GET', '/api/skills');
    assert.equal(r.status, 200);
    assert.equal(r.data.skills.some((s) => s.id === 'ok-skill'), false);
    assert.equal((r.data.uninstalled || []).some((u) => u.id === 'ok-skill'), false,
      '配置已随删除清理，不应出现在"已配置但未安装"里');
  });

  await c.check('DELETE 后：GET /api/config 的 skills 段没有该 id', async () => {
    const r = await request('GET', '/api/config');
    assert.equal(r.status, 200);
    assert.equal(Object.prototype.hasOwnProperty.call(r.data.skills || {}, 'ok-skill'), false);
  });

  await c.check('DELETE 技能不影响插件：插件仍在列表且磁盘未动', async () => {
    const r = await request('GET', '/api/skills');
    const plugin = r.data.skills.find((s) => s.id === 'ok-plugin');
    assert.ok(plugin, '插件不应被误删');
    assert.equal(plugin.loaded, true);
    assert.equal(exists(path.join(fixtures.okPluginDir, 'plugin.json')), true);
    assert.equal(exists(path.join(fixtures.okPluginDir, 'index.js')), true);
  });

  await c.check('再次 DELETE 同 id → 404（已不在注册表）', async () => {
    const r = await request('DELETE', '/api/skills/ok-skill');
    assert.equal(r.status, 404);
    assert.equal(r.data.ok, false);
    assert.ok(String(r.data.error || '').length > 0);
  });

  await c.check('DELETE 不存在的 id → 404', async () => {
    const r = await request('DELETE', '/api/skills/no-such-skill-xyz');
    assert.equal(r.status, 404);
    assert.equal(r.data.ok, false);
    assert.ok(String(r.data.error || '').length > 0);
  });

  await c.check('DELETE 路径校验失败（注册表 dir 被改成根外）→ 409 且磁盘/注册表不动', async () => {
    // 注册表里的 dir 正常来自加载器，但"配置/目录可能被外部改过"，路由必须从头校验。
    // 这里直接把内存里 guard-skill 的 dir 改成根外目录来驱动 409 分支。
    const { skillManager } = await import('../src/skills/manager.js');
    const entry = skillManager.registry.get('guard-skill');
    assert.ok(entry, 'guard-skill 应已注册');
    const realDir = entry.dir;
    entry.dir = path.join(TMP_ROOT, 'outside-dir');
    try {
      const r = await request('DELETE', '/api/skills/guard-skill');
      assert.equal(r.status, 409, '路径不在扩展根内应返回 409（请求合法，磁盘状态不允许）');
      assert.equal(r.data.ok, false);
      assert.ok(String(r.data.error || '').length > 0);
      assert.equal(exists(fixtures.guardSkillDir), true, '409 时磁盘不能被删');
      const list = await request('GET', '/api/skills');
      assert.ok(list.data.skills.some((s) => s.id === 'guard-skill'), '409 时注册表条目应保留');
    } finally {
      entry.dir = realDir;   // 还原，避免影响后续断言
    }
  });

  await c.check('恢复注册表 dir 后 DELETE → 200（409 分支无副作用）', async () => {
    const r = await request('DELETE', '/api/skills/guard-skill');
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.removedConfig, false, 'guard-skill 没有配置残留，removedConfig 应为 false');
    assert.equal(exists(fixtures.guardSkillDir), false);
  });

  await c.check('POST /api/skills/reload：200 且已删条目不会复活', async () => {
    const r = await request('POST', '/api/skills/reload');
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.skills.some((s) => s.id === 'ok-skill'), false, '重扫后已删技能不能复活');
    assert.equal(r.data.skills.some((s) => s.id === 'guard-skill'), false);
    assert.ok(r.data.skills.some((s) => s.id === 'ok-plugin'), '插件应仍在');
    assert.ok((r.data.loaded || []).includes('ok-plugin'), '重扫结果里应有仍在磁盘上的插件');
  });

  await c.check('DELETE 加载失败条目（缺 index.js 的 broken-skill）→ 200 且目录消失', async () => {
    const r = await request('DELETE', '/api/skills/broken-skill');
    assert.equal(r.status, 200, '加载失败条目也要能删（坏目录正是最该清理的）');
    assert.equal(r.data.ok, true);
    assert.equal(r.data.id, 'broken-skill');
    assert.equal(exists(fixtures.brokenSkillDir), false);
    const list = await request('GET', '/api/skills');
    assert.equal(list.data.skills.some((s) => s.id === 'broken-skill'), false);
  });

  await c.check('DELETE 插件（plugins/ 根）→ 200 且目录消失', async () => {
    const r = await request('DELETE', '/api/skills/ok-plugin');
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.id, 'ok-plugin');
    assert.ok(String(r.data.dir || '').includes('ok-plugin'), `dir 应指向被删插件：${r.data.dir}`);
    assert.equal(exists(fixtures.okPluginDir), false, 'plugins/ok-plugin 目录应消失');
  });

  await c.check('全部删完后：GET /api/skills 为空且无残留配置', async () => {
    const r = await request('GET', '/api/skills');
    assert.equal(r.status, 200);
    assert.equal(r.data.skills.length, 0);
    assert.equal((r.data.uninstalled || []).length, 0);
    const cfg = await request('GET', '/api/config');
    assert.deepEqual(cfg.data.skills || {}, {}, '配置里的 skills 段应已清空');
  });
} catch (error) {
  c.bad('HTTP 集成测试执行中断（未预期异常）', error);
} finally {
  if (ctx) {
    try { await ctx.teardown(); } catch { /* 清理失败不影响测试结论 */ }
  }
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows 句柄未释放时留给系统临时目录清理 */ }
}

c.finish();
