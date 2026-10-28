# dsh-session-purge

> 🛡️ 在 DSH 侧边栏对话菜单中**真正物理删除**会话 —— 从文件系统层面彻底销毁日志与目录，杜绝幽灵残留、路径误删与越权风险。

DSH（DeepSeek Harness）官方客户端目前仅提供「归档会话」（把会话从侧边栏列表隐藏，会话文件依然完整留在磁盘中）。  
**`dsh-session-purge`** 在会话行 `···` 操作菜单中新增「**彻底删除**」入口：点击并确认后，会话目录及日志文件将从本地磁盘彻底抹除，**不可恢复**。

---

## ✨ 核心特性

- 🔒 **防误删路径安全断言（独家）**：
  - 针对底层持久化路径进行严格的子目录/文件名多重断言，确保删除目标**严格与目标 `sessionId` 绑定**，杜绝因 `dirname` 误指上级目录而清空整个工作区所有会话的致命隐患。
- 🛡️ **严格的 CSRF 与本地请求防护**：
  - 除了检查 `Host` 为本地地址外，严格拦截不合法的外部跨站 `Origin` 与 `Sec-Fetch-Site: cross-site` 恶意探测，防止恶意网页在后台静默发起删除请求。
- 🎯 **多级高精度会话识别机制**：
  - **Tier 1**：优先探测 React Fiber / Props 获取底层绑定的真实 `sessionId`，免疫 DOM 树序变化；
  - **Tier 2**：DOM 原生属性与超链接回溯匹配；
  - **Tier 3**：工作区 Store 标题唯一性比对；
  - **Tier 4**：侧边栏 DOM 树序与 `updatedAt` 时间戳保底回退。
- ⚡ **运行中会话安全脱机**：
  - 针对正在生成或处于内存状态的会话，自动取消正在进行的 Agent Turn，并通过标准 `sessions.store.detach()` 从内存脱机，防止删除后被内存定时落盘再次“复活”。
- 🎨 **现代化原生交互体验**：
  - 弃用传统的阻塞式 `window.confirm` 和 `window.alert`，采用与 DSH 视觉设计语言对齐的非阻塞沉浸式模态确认弹窗与轻量 Toast 通知，支持键盘 `Esc` 取消与 `Enter` 快捷确认。
- 🧹 **记账数据完全同步**：
  - 同步清理 `workspace.json` 中的席位以及全局归档集合（`archivedSessionIds`），不留任何幽灵空项。
- 📦 **零第三方运行时依赖**：
  - 纯净实现，仅调用 Node.js 内置模块与 DSH 官方注入服务。

---

## 🚀 安装

在终端中执行：

```sh
npx -p @deepseek-ai/dsh dsh plugin --profile web add i-WZX/dsh-session-purge
```

也可以直接通过 GitHub 仓库安装：

```sh
npx -p @deepseek-ai/dsh dsh plugin --profile web add github:i-WZX/dsh-session-purge
```

安装完成后，**重启 DSH Web 实例**即可生效。

---

## 📖 使用方法

1. 打开 DSH 界面，在左侧侧边栏对话列表中找到需要清理的目标会话；
2. 鼠标悬停在会话行上，点击行尾出现的 `···` 操作按钮；
3. 在弹出的菜单中点击带有红色高亮的「**彻底删除**」（英文环境为 `Purge session`）；
4. 在确认弹窗中确认会话标题无误后，点击「彻底删除」；
5. 会话立即从侧边栏移除，本地磁盘上的会话目录已被物理销毁。

---

## 🔍 技术实现与架构原理

插件分为 Host（Node.js 端）与 Client（浏览器端）两大部分：

```
[Web 前端 (lib/client.js)]
   │
   ├─ 全局捕捉 pointerdown/click/contextmenu 锁定目标锚点
   ├─ MutationObserver 拦截会话操作菜单 DOM，注入「彻底删除」选项
   ├─ 多级算法精确解析会话真实 sessionId
   ├─ 唤起原生风格确认弹窗
   └─ 触发 POST /session-purge/api/purge
   │
   ▼
[Host 端 (lib/index.js)]
   │
   ├─ CSRF 过滤 (Origin / Host / Sec-Fetch-Site 白名单)
   ├─ 严格校验 sessionId 格式为 `session-<uuid>`
   ├─ 内存解耦：agents.cancel() 终止 Turn + sessions.detach() 剔除内存
   ├─ 路径防御：resolveSafePurgeTarget() 校验确保路径仅指向该 session
   ├─ 物理销毁：rm(targetPath, { recursive, force })
   └─ 记账同步：workspaceRegistry 剔除 sessionIds 与 archivedSessionIds
```

---

## 🧪 自动化测试与质量保障

本项目配备严密的本地测试套件，全面覆盖安全拦截、语法校验、真实文件销毁模拟与数据隐私检查：

```sh
node scripts/verify.mjs
```

测试覆盖指标：
- [x] Host / Client 语法与 Cordis 插件规范校验
- [x] 路径安全防穿透与父目录误删拦截测试
- [x] 跨站 CSRF 来源拒绝测试（403）
- [x] 运行中会话的中止与 Detach 校验
- [x] 真实临时目录的物理删除及 Workspace 记账同步
- [x] 前端 React Fiber 与 DOM 属性多级识别测试
- [x] 零硬编码绝对路径与隐私泄露扫描

---

## 📄 License

[MIT](LICENSE) © 2026 i-WZX
