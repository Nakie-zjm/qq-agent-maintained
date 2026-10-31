// 删除扩展目录（skills/<id>/ 或 plugins/<id>/）：安全边界集中在这里。
//
// 独立成模块的原因与 zip-install.js 相同：这里是后端**唯一会递归删除用户磁盘
// 目录**的入口。边界一旦写松，"删一个技能"就可能变成删整个 skills/、删仓库根，
// 或者顺着符号链接删到根目录之外。把判定抽成纯函数后：
//   · 路由只负责编排业务流程（404 / 409 / 500 的语义），不重复写路径规则；
//   · 安全规则可以单测：符号链接、根外路径、根目录本身、深层子目录。
//
// 判定规则（全部满足才允许删）：
//   1. dir 是绝对路径，且**父目录恰好等于** skills/ 或 plugins/ 根（即直接子目录）；
//   2. dir 真实存在，且 lstat 结果是目录（不是文件）；
//   3. dir 本身**不是**符号链接 / junction —— 否则 rm 会顺着链接删到别处；
//   4. 再用 realpath 比一次：真实父目录必须等于真实根目录。
//      第 1 条只比较了"书写路径"，而根目录本身可能就是软链（用户把 skills/
//      链接到别的盘），不经过 realpath 证明不了真实位置仍在根内。
import fs from 'node:fs';
import path from 'node:path';

// Windows / macOS 的默认文件系统大小写不敏感：D:\QQ-agent\skills 与
// d:\qq-agent\skills 是同一处；不归一化会把合法目录误判成"根外"。
// Linux 必须保持区分大小写（小写化会让两个不同目录被当成同一个）。
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p) => (CASE_INSENSITIVE_FS ? String(p).toLowerCase() : String(p));
const samePath = (a, b) => norm(a) === norm(b);

/** 统一的失败返回：code 给程序判断，error 是可直接展示给用户的中文原因。 */
function deny(code, error) {
  return { ok: false, code, error };
}

/**
 * 判断 dir 能否安全删除。
 *
 * @param {string} dir 待删除目录（注册表里的绝对路径，即 skill.dir）
 * @param {string[]|{skills:string,plugins:string}} roots
 *        扩展根目录，约定传 [SKILLS_DIR, PLUGINS_DIR]；也兼容 SKILL_DIRS 对象
 * @returns {{ok:true,dir:string,root:string,name:string}|{ok:false,code:string,error:string}}
 *          ok 时的 dir/root 都是 path.resolve 后的绝对路径
 */
export function resolveDeletableExtensionDir(dir, roots = []) {
  // ── 1. 入参形状：空值 / 相对路径都不该走到删除逻辑 ──────────────────────
  // 相对路径在这里尤其危险：path.resolve 会按 process.cwd() 补全，
  // 打包版里 cwd 是 <install>/ 而不是 app/，补出来的目标完全不可预期。
  if (typeof dir !== 'string' || !dir.trim()) {
    return deny('invalid-dir', '删除目标为空：缺少要删除的目录路径');
  }
  if (!path.isAbsolute(dir)) {
    return deny('relative-dir', `删除目标必须是绝对路径（收到：${dir}）`);
  }

  // roots 兼容数组与 { skills, plugins } 对象两种传法（路由传 SKILL_DIRS 对象）
  const rootList = Array.isArray(roots)
    ? roots
    : (roots && typeof roots === 'object' ? Object.values(roots) : []);
  const validRoots = rootList
    .filter((r) => typeof r === 'string' && r.trim() !== '' && path.isAbsolute(r))
    .map((r) => path.resolve(r));
  if (!validRoots.length) {
    return deny('no-roots', '没有可用的扩展根目录（skills/、plugins/），已拒绝删除');
  }

  const target = path.resolve(dir);

  // ── 2. 必须是某个根的**直接子目录** ────────────────────────────────────
  // 用"父目录严格相等"而不是 startsWith：startsWith 会放过
  // <root>-backup/xxx 这类同前缀目录（"skills_backup" 是 "skills" 的前缀）。
  let root = null;
  for (const candidate of validRoots) {
    if (samePath(target, candidate)) {
      return deny('root-itself', `不能删除扩展根目录本身：${candidate}`);
    }
    if (samePath(path.dirname(target), candidate)) { root = candidate; break; }
  }
  if (!root) {
    // 分两种报错，"根内深层子目录"和"彻底在根外"的处置方式不一样：
    // 前者是用户点错了层级（只能删根的直接子目录），后者说明注册表里的
    // 路径被污染了 —— 两种都要能一眼看出来。
    const insideRoot = validRoots.find((candidate) => {
      const rel = path.relative(candidate, target);
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
    if (insideRoot) {
      return deny('not-direct-child',
        `只能删除技能/插件根目录下的直接子目录（不能删深层目录）：${path.relative(insideRoot, target)}`);
    }
    return deny('outside-root', `目录不在技能/插件根目录下，已拒绝删除：${target}`);
  }

  // ── 3. 磁盘状态：存在、不是链接、确实是目录 ────────────────────────────
  let st;
  try {
    // 必须用 lstat 而不是 stat：stat 会跟随链接，链接本身就被"消失"了，
    // 后面 rm 时目录联接会被当成普通目录处理，等于把链接点删成了目标内容。
    st = fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return deny('not-found', `目录不存在（可能已被删除）：${target}`);
    }
    return deny('stat-failed', `无法检查目录状态：${String(error?.message ?? error)}`);
  }
  if (st.isSymbolicLink()) {
    return deny('symlink', `拒绝删除符号链接或目录联接（junction）：${target}`);
  }
  if (!st.isDirectory()) {
    return deny('not-directory', `不是目录，已拒绝删除：${target}`);
  }

  // ── 4. realpath 兜底：真实父目录必须等于真实根目录 ─────────────────────
  // 覆盖"根目录本身是软链"的场景；同时挡住 3 与 rm 之间被换成链接的竞态
  // 剩余部分（换链接由路由侧调用前的二次校验 + 这里再校验共同收敛）。
  let realRoot;
  let realTarget;
  try {
    realRoot = fs.realpathSync(root);
    realTarget = fs.realpathSync(target);
  } catch (error) {
    return deny('realpath-failed', `无法解析目录的真实路径：${String(error?.message ?? error)}`);
  }
  if (samePath(realTarget, realRoot) || !samePath(path.dirname(realTarget), realRoot)) {
    return deny('escapes-root', `目录经符号链接指向了扩展根目录之外，已拒绝删除：${target}`);
  }

  return { ok: true, dir: target, root, name: path.basename(target) };
}

/**
 * 校验 + 递归删除一个扩展目录。
 *
 * 校验失败**返回** { ok:false, code, error }（此时磁盘上什么都没动）；
 * 删除过程中的 I/O 错误（EBUSY / EPERM / ENOENT…）**原样抛出**，由调用方决定
 * HTTP 语义（路由把校验失败映射成 409、把删除失败映射成 500）。这样"为什么
 * 删不掉"的原始信息不会被这里吞成一句笼统的失败。
 *
 * maxRetries / retryDelay：Windows 上杀毒软件与索引服务会短暂占用刚被扫描过
 * 的文件，立即 rm 常见 EBUSY / EPERM。Node fs.rm 自带退避重试，能吸收这类
 * 瞬时占用；3 次 × 120ms 仍失败就是真失败（如进程持有句柄）。
 */
export async function removeExtensionDir(dir, roots = [], { maxRetries = 3, retryDelay = 120 } = {}) {
  const check = resolveDeletableExtensionDir(dir, roots);
  if (!check.ok) return check;
  await fs.promises.rm(check.dir, { recursive: true, force: false, maxRetries, retryDelay });
  return check;
}
