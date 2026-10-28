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
- 🧭 **多级会话定位**：
  - 优先通过官方 `sessionPersistence` 定位；若官方接口未返回该会话（如跨工作区、新版 `session.v4.jsonl.zstd` 格式），自动回退扫描 `~/.dsh/sessions/{workspace}/{sessionId}`，同样受路径安全断言保护。
- 🎨 **醒目的警示确认弹窗**：
  - 弃用阻塞式 `window.confirm` / `window.alert`，采用白底 + 黄色粗边框 + 三角警示图标的确认弹窗与轻量 Toast 通知，支持键盘 `Esc` 取消、`Enter` 确认。
- 🎯 **菜单精准注入**：
  - 仅在单条会话的 `···` 菜单（含「归档对话」项）中注入「彻底删除」，不会误入侧边栏顶部的分组/排序/筛选菜单。
- 🧹 **记账与缓存完全同步**：
  - 同步清理 `workspace.json` 中的会话席位、全局归档集合（`archivedSessionIds`）以及投影缓存 `storages/session_projcache/sessions/{sessionId}.json`，不留幽灵残留。
- 📦 **零第三方运行时依赖**：
  - 纯净实现，仅调用 Node.js 内置模块与 DSH 官方注入服务。

---

## 🚀 安装

请根据你使用的 DSH 形态选择对应的 profile：

| 使用形态 | profile |
| :--- | :--- |
| DeepSeek Harness 桌面客户端 | `desktop` |
| 浏览器访问的 DSH Web | `web` |

### 方式 1：DSH 客户端内安装（推荐）

在「插件管理 / 社区插件市场」的安装输入框中填入 `i-WZX/dsh-session-purge`，安装后重启客户端。

### 方式 2：命令行安装

**桌面客户端**（`dsh` 命令随客户端一同安装，位于安装目录 `resources\runtime\cli\bin\dsh.cmd`）：

```sh
dsh plugin --profile desktop add github:i-WZX/dsh-session-purge
```

**DSH Web**：

```sh
npx -p @deepseek-ai/dsh dsh plugin --profile web add github:i-WZX/dsh-session-purge
```

**本地开发链接**（修改源码后重启 DSH 即生效，无需重复安装）：

```sh
dsh plugin --profile desktop add "<本仓库的本地绝对路径>"
```

安装完成后，**完全退出并重新打开 DSH**（桌面版请从托盘右键退出）即可生效。

### 卸载

```sh
dsh plugin --profile desktop remove dsh-session-purge
```

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
   ├─ 定位回退：官方接口未命中时扫描 ~/.dsh/sessions/{workspace}/{sessionId}
   ├─ 物理销毁：rm(targetPath, { recursive, force }) + 删除投影缓存
   └─ 记账同步：workspaceRegistry + workspace.json 剔除 sessionIds 与 archivedSessionIds
```

---

## ❓ 常见问题

| 问题 | 说明 |
| :--- | :--- |
| 安装后 `···` 菜单里没有「彻底删除」 | 确认安装到了正确的 profile（桌面版是 `desktop`），并完全退出后重新打开 DSH |
| 彻底删除后能在「显示已归档」里找回吗？ | **不能**。归档只是隐藏，文件还在磁盘上；彻底删除会把会话目录和缓存从磁盘移除，无法恢复 |
| 提示「无法识别该会话，请刷新重试」 | 侧边栏与数据快照短暂不一致时可能出现，按 `Ctrl + R` 刷新窗口后重试 |
| 删除后磁盘占用没明显减少 | 附件（图片等）是多个会话共享的资源，不会随会话一起删除 |
| 子代理（subagent）会话会一起删除吗？ | 不会，子代理会话单独存储，需要分别删除 |

---

## ⚠️ 免责声明

彻底删除**不可恢复**，请确认后再操作。使用本插件造成的数据损失由使用者自行承担。

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
