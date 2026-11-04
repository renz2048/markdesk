# 技术选型对比：Electron（历史） vs Tauri（当前）

MarkDesk 0.3.0 之前基于 **Electron**，2026-11 起整体迁移到 **Tauri** 单架构。
本文档记录两套框架的对比与迁移决策。

## Electron 架构（迁移前）

Electron 的思路是"每个应用自带一个完整浏览器"：

```
┌─────────────────────────────────────┐
│  MarkDesk.exe（74.9 MB）            │
│  ├── Chromium（完整浏览器内核）      │ ← 渲染界面用，约占 60+ MB
│  ├── Node.js 运行时                 │ ← 主进程逻辑用
│  └── app.asar（应用代码，2.4 MB）    │
└─────────────────────────────────────┘
```

分层：Electron 33（TypeScript 主进程：窗口、原生菜单、文件 IPC、安全沙箱）+
React 18 渲染进程 + ProseMirror / CodeMirror 6 编辑器 + Vite / electron-builder。

安装包的"硬底价"（约 70+ MB）来自 Chromium + Node 运行时——每个 Electron 应用
都独立携带一份。

## Tauri 架构（迁移后）

相反思路：**不带浏览器，使用操作系统自带的 WebView**（Windows 的 WebView2、
macOS 的 WKWebView、Linux 的 WebKitGTK），后端用 **Rust** 编写。

```
┌───────────────────────────────┐
│  MarkDesk_0.3.0_x64-setup.exe（3.76 MB） │
│  ├── 应用代码（Rust 主进程）    │
│  └── 前端产物（Web 页面）       │ ← 界面由系统 WebView 渲染
└───────────────────────────────┘
```

## 对比

| | Electron（迁移前） | Tauri（迁移后） |
| --- | --- | --- |
| 界面引擎 | 自带 Chromium | 系统 WebView（Windows 的 WebView2 基于 Chromium） |
| 后端语言 | Node.js（TypeScript） | Rust |
| 前端 | 任意 Web 框架（React 等） | 任意 Web 框架——迁移时原样保留 |
| 安装包体积 | 74.9 MB | **3.76 MB** |
| 内存占用 | 较高 | 较低 |
| 界面一致性 | 所有平台同一 Chromium 版本 | 依赖各平台 WebView 版本 |
| 生态成熟度 | 极成熟（VS Code、Slack、Typora） | 较新但发展快 |
| Windows 运行时依赖 | 无（全部自带） | 需 WebView2 运行时（Win10/11 一般自带） |

## 迁移的实际工作量

- **原样保留**：React 界面、ProseMirror / CodeMirror 编辑器、CSS 主题、
  Markdown 管线（`src/markdown/`）
- **Rust 重写**（原 `src/electron/` 全部职责）：路径策略与受限资源协议
  （`markdesk-resource` 授权解析）、文件服务（指纹/原子写/编码校验）、最近文件、
  恢复草稿、图片授权表、原生菜单、关闭保护、Pandoc 调用、主题跟随
- **换方案**：PDF/图像导出从隐藏窗口 `printToPDF`/`capturePage` 改为隐藏
  WebView2 窗口驱动 CDP（`Page.printToPDF` / `Page.captureScreenshot`，
  经 webview2-com COM 回调实现）
- **平台适配层**：渲染端以 `MarkDeskRendererApi` 接口隔离，Electron 的
  `window.markdesk` 与 Tauri 的 invoke 适配器可互换（迁移完成后仅保留后者）

## 结论

Typora 本身就是 Electron 应用，MarkDesk 最初克隆的正是这条技术路线。迁移后
安装包 74.9 MB → 3.76 MB（约 1/20），安全模型逐条移植并通过测试（Rust 单测 +
CDP 冒烟）。本文保留作为迁移决策的记录。
