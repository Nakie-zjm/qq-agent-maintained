# QQ Agent（个人维护副本）

> **这不是官方仓库。** 上游 [`Kondius/qq-agent`](https://github.com/Kondius/qq-agent) 已于 2026 年 10 月前后被删除（GitHub 返回 404），原作者不再维护。
> 本仓库 **`Nakie-zjm/qq-agent-maintained`** 是第三方个人维护副本，只为自用而修：会修自己遇到的问题，但**不保证**及时响应 issue、**不保证**与任何版本兼容、**不保证**跟进新功能。
> 代码沿用 MIT 许可（见 [LICENSE](LICENSE)），版权归原作者 **Kondius**；"仿真群友"的整体思路来自 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)（MIT）。完整声明见 [NOTICE.md](NOTICE.md)，上游原始 README 存档在 [doc/UPSTREAM_README.md](doc/UPSTREAM_README.md)。

一个跑在 Windows 上的 QQ 群机器人：通过 OneBot v11（[SnowLuma](https://github.com/SnowLuma/SnowLuma)）接入 QQ，接任意 OpenAI 兼容 API 当大脑。事件驱动 + 无状态会话，每次处理的 token 成本恒定，所有操作在图形控制台里完成。

## 本副本改了什么

**移除**（原作者服务器已下线，相关功能不再可用）：

- 在线服务：意见收集、金句上传、技能市场、插件市场、人设广场、匿名用量遥测、云端共享屏蔽名单、远程价格表、在线更新检查、阿里云验证码
- 便携版 QQ 的下载与分发：**本仓库不提供 QQ 安装包**，也不提供任何网盘镜像
- 作者的 QQ 群二维码、社区后端源码（原 `server/`）、作者专用的发布 workflow

**保留**（全部本地能力，不依赖任何外部服务）：

- QQ 收发：私聊 / 群聊、引用、@、戳一戳、表情包、图片、合并转发
- 人设与提示词、长期记忆、表情包收集与发送、插件 / 技能系统
- 多模型 / 多渠道、用量与花费统计、本地黑名单、内置模型价格表
- 完整图形控制台（`http://127.0.0.1:3210`）

## 前置条件

| 组件 | 要求 |
| --- | --- |
| 系统 | Windows 10 / 11 x64（SnowLuma 原生组件只有 win-x64 版本） |
| Node.js | ≥ 20 |
| 机器人账号 | 一个单独的 QQ 号（不建议用主力号） |
| 协议端 | [SnowLuma](https://github.com/SnowLuma/SnowLuma) 官方 Release，自行下载解压到项目根的 `snowluma/` |
| QQ 客户端 | 本机已安装的 QQ（`npm run setup` 会从已装 QQ 复制一份便携运行时），或自备安装包 |
| 模型 | 任意 OpenAI 兼容 API 的 Base URL + Key |

> QQ 与 SnowLuma 都需要你自己准备：本副本**不下载、不分发**它们，也不提供任何下载镜像。

## 安装

```bash
git clone https://github.com/Nakie-zjm/qq-agent-maintained.git
cd qq-agent-maintained
npm install
```

然后把 **SnowLuma** 解压到项目根目录（目录名保持 `snowluma`），确认本机已装过 QQ，再执行：

```bash
npm run setup        # 检查环境并生成 runtime/ 下的便携 QQ（不联网下载安装包）
```

启动：

```bat
启动QQ机器人.bat        REM 或 npm start
```

首次打开控制台（`http://127.0.0.1:3210`）后：在设置页填 API 地址与 Key → 选模型 → 勾选要响应的群/好友白名单 → 在 SnowLuma 页签启动 QQ 并扫码登录。

> 白名单为空时机器人**不响应任何消息**（刻意的 fail-closed 默认值），记得先勾选。

## 目录结构

```
src/           主程序（事件循环、提示词、工具、记忆、控制台后端）
ui/            控制台前端（原生 HTML/CSS/JS）
electron/      桌面壳（托盘、窗口、启动逻辑）
plugins/       确定性扩展（钩子 / 能力提供者）——本仓库为空，按需自建
skills/        LLM 扩展（工具 + 提示词片段）——本仓库为空，按需自建
doc/           开发文档；doc/UPSTREAM_README.md 是原作者 README 存档
data/          运行时数据（聊天记录、记忆、配置，含 API Key）——不入库
snowluma/      SnowLuma 运行时——不入库
```

扩展开发见 [doc/extend_development/](doc/extend_development/)。

## 测试

```bash
npm test
```

当前 **23 / 26 套通过**。3 套已知红灯，均为上游遗留问题，与本副本的改动无关：

- `test/selftest.mjs`：端到端链路在"第一次 LLM 调用"处超时
- `test/wake-semantics-test.mjs`：9 条唤醒 / 批处理语义断言失败
- `test/tools-skill-audit.mjs`：需要本机存在自定义技能时才全绿（本副本不带技能）

## 已知限制

- 收到的语音消息只显示占位文本，不做转写
- 收到的视频、部分无法取得字节的图片同样退化为占位文本
- 机器人回复在回合结束时一次性发出，不做流式转发
- Markdown 会转成 QQ 纯文本
- 只支持 Windows

## 风险提示

QQ 机器人基于非官方协议实现（SnowLuma 通过原生组件挂进 QQ 客户端），**存在账号被限制的风险**，仅供学习与技术研究，请不要使用主力账号。本仓库只以 OneBot 协议与 SnowLuma 通信，不包含、不修改、不部署 SnowLuma，使用前请自行阅读并遵守其 EULA 与《QQ 用户协议》。

## 许可

MIT（见 [LICENSE](LICENSE)）。版权归原作者 **Kondius** 所有；上游 qq-bridge 版权归 Derpyu520 及贡献者所有。SnowLuma 是独立第三方项目，不在本仓库内分发，也不受本仓库许可覆盖。
