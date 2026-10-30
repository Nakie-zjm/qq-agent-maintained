// 测试隔离：把扩展目录（skills/ 与 plugins/）指向临时空目录。
//
// 为什么需要：仓库本身不带任何扩展，但用户本机往往自装了一堆。那些扩展会注册
// 定时器、改写提示词、拦截消息判定 —— 于是"同一份代码，测试结果取决于这台机器
// 上装了什么"。历史上 wake-semantics / selftest 的失败正是这么来的。
//
// 用法：在会启动 app 的测试里最早一行 `import './_isolate.mjs';`。
// 想拿真实扩展跑测试时，自己先设 QQ_AGENT_SKILLS_DIR / QQ_AGENT_PLUGINS_DIR 即可
// （下面的逻辑只在环境变量未设置时才生效）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.QQ_AGENT_SKILLS_DIR || !process.env.QQ_AGENT_PLUGINS_DIR) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-tests-ext-'));
  process.env.QQ_AGENT_SKILLS_DIR = process.env.QQ_AGENT_SKILLS_DIR || path.join(base, 'skills');
  process.env.QQ_AGENT_PLUGINS_DIR = process.env.QQ_AGENT_PLUGINS_DIR || path.join(base, 'plugins');
}
