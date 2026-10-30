// 全局屏蔽名单（纯本地版）。
//
// 原作者的「云端共享屏蔽名单」已随上游一起下线：本副本不再有社区接口、定时同步、
// 管理密钥与云端缓存 —— 名单**只来自** config.json 的 globalBlocklist。
//
// 这里保留与原模块同名的导出，是为了让 routes.js / app.js / 测试不必大改：
//   · getGlobalBlocklist() / isGloballyBlocked() / updateGlobalBlocklist()  —— 读写本地配置
//   · syncGlobalBlocklist() / startCommunitySync()                        —— 保持 API 形状，不做网络请求
//   · COMMUNITY_API_BASE                                                  —— 固定为空，供断言"没有社区接口"
import { getConfig, updateConfig } from './config.js';

export const COMMUNITY_API_BASE = '';

/**
 * 规范化 QQ 号列表。
 * ⚠️ 用 1~12 位宽松校验，不要收紧成"真实 QQ 号 5 位起"：
 *   配置里出现的短号码也必须照样生效，收紧了会静默丢掉屏蔽项。
 */
function normalizeIds(value) {
  const input = Array.isArray(value) ? value : [];
  return [...new Set(input.map((x) => String(x ?? '').trim()).filter((x) => /^\d{1,12}$/.test(x)))].slice(0, 20000);
}

/**
 * 本机豁免名单：控制台里"解除屏蔽"的持久化载体。
 * 独立字段 communityExemptions，不与 globalBlocklist 混写。
 */
function getCommunityExemptions() {
  return normalizeIds(getConfig().communityExemptions);
}

export function getCommunityExemptionsForTest() {
  return getCommunityExemptions();
}

/**
 * 当前生效的全局屏蔽名单 = 配置里的 globalBlocklist − 本机豁免。
 *
 * ⚠️ 必须每次都读一遍当前配置，不能只在首次加载时快照：
 *   运行中通过控制台/接口改 globalBlocklist 必须立即生效，
 *   否则会出现"设置里明明拉黑了、消息还是被处理"的回归。
 */
export function getGlobalBlocklist() {
  const exemptions = new Set(getCommunityExemptions());
  return normalizeIds(getConfig().globalBlocklist).filter((id) => !exemptions.has(id));
}

export function isGloballyBlocked(userId) {
  return getGlobalBlocklist().includes(String(userId ?? ''));
}

/**
 * 本地更新屏蔽名单（add / remove / replace 三种语义）。
 * 返回值保留原形状 { ids, warning }，warning 恒为空（没有云端了，不会有"只在本地生效"的提示）。
 */
export async function updateGlobalBlocklist(ids, { mode = 'replace' } = {}) {
  const local = getGlobalBlocklist();
  const next = normalizeIds(ids);
  let desired;
  if (mode === 'add') desired = [...new Set([...local, ...next])];
  else if (mode === 'remove') {
    const set = new Set(local);
    for (const id of next) set.delete(id);
    const exemptions = new Set(getCommunityExemptions());
    for (const id of next) exemptions.add(id);   // 解除的号码进豁免名单，避免被旧配置再带回来
    updateConfig({ communityExemptions: { __replace__: [...exemptions] } });
    desired = [...set];
  } else {
    desired = next;
  }
  updateConfig({ globalBlocklist: { __replace__: desired } });
  return { ids: desired, warning: '' };
}

/** 兼容旧调用：不再同步云端，直接返回本地名单。 */
export async function syncGlobalBlocklist() {
  return getGlobalBlocklist();
}

/** 兼容旧调用：没有社区接口，不启动任何定时器。 */
export function startCommunitySync() {
  return null;
}

export function setCommunityApiBaseForTest() {
  return COMMUNITY_API_BASE;
}
