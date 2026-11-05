# MarkDesk

MarkDesk 是一个安全的单文件 Markdown 阅读器与编辑器（**Tauri 2 + Rust + React +
ProseMirror + CodeMirror 6**）。界面运行在系统 WebView（Windows 为 WebView2）中，
所有文件访问都经过 Rust 主进程校验的 invoke 通道；保存采用临时文件 + 原子替换，
并带外部修改检测、恢复草稿与净化后的 HTML 导出。安装包约 4 MB。

> 0.3.0 之前本项目基于 Electron；2026-11 起整体迁移到 Tauri 单架构
>（对比分析见 `docs/electron-vs-tauri.md`）。

## 界面分区

主窗口从上到下分为五层（编辑区左侧为侧边栏）：

```
┌──────────────────────────────────────────────┐
│ 窗口标题栏        note.md● - MarkDesk   ─ □ ✕ │
├──────────────────────────────────────────────┤
│ 菜单栏       文件  编辑  段落  格式  模式  主题    │
├──────────┬───────────────────────────────────┤
│          │                                   │
│  侧边栏   │             编辑区                 │
│ （大纲）  │                                   │
│  直达底部 │                                   │
│          ├───────────────────────────────────┤
│          │                              < </>│ ← 状态栏（与编辑区同宽）
└──────────┴───────────────────────────────────┘
```

### 窗口标题栏

操作系统原生标题栏，显示应用图标与标题，右侧为最小化/最大化/关闭按钮。
标题随文档状态变化：

| 状态 | 标题 |
| --- | --- |
| 未打开文件（欢迎页） | `MarkDesk` |
| 已打开且已保存 | `note.md - MarkDesk` |
| 已打开且有未保存修改 | `note.md● - MarkDesk`（文件名后的实心圆点即脏标记） |
| 新建文档未保存 | `未命名● - MarkDesk` |

### 菜单栏

菜单顺序与快捷键对齐 Typora：**文件、编辑、段落、格式、模式、主题**。

- **文件**：新建 Ctrl+N、新窗口 Ctrl+Shift+N、打开 Ctrl+O、保存 Ctrl+S、
  另存为 Ctrl+Shift+S、导出（HTML / PDF / 图像）、最近打开、关闭 Ctrl+W
- **段落**：段落 Ctrl+0（标题切回普通段落）、一级～六级标题 Ctrl+1~6、
  提升/降低标题级别 Ctrl+=/-、表格 Ctrl+T、
  代码块 Ctrl+Shift+K、引用块 Ctrl+Shift+Q、有序/无序列表 Ctrl+Shift+O/U、
  任务列表、水平分割线 Ctrl+Shift+-
- **格式**：加粗 Ctrl+B、斜体 Ctrl+I、删除线 Ctrl+Shift+X、代码 Ctrl+Shift+\`、
  图像 Ctrl+Shift+I、清除格式 Ctrl+\\
- **模式**：所见即所得 / 源码模式（Ctrl+/）/ 阅读
- **主题**：浅色 / 深色 / 跟随系统（单选，标题栏与菜单栏随主题变化）

其中 Word / OpenOffice / Epub / LaTeX / MediaWiki 导出经系统 Pandoc 转换，
未安装时点击会提示安装（`winget install --id JohnMacFarlane.Pandoc`）。

### 侧边栏（文档大纲）

- 列出当前文档的标题层级，点击跳转到对应位置，当前所在标题高亮加粗
- 与右侧编辑区之间有 4px 拖拽条，可拖拽调节宽度（120–480px，默认 150px，宽度本地记忆）
- 直达窗口底部；通过状态栏 `<` / `>` 收起或展开（收起后编辑区独占整行）

### 编辑区

文档主体，支持三种模式（菜单「模式」或状态栏 `</>` 切换）：

- **所见即所得**（默认）：Typora 式输入——行首 `- `/`1. ` + 空格立即转为列表，
  回车续项、空项回车逐级退层（3 层→2 层→1 层→段落，光标留在空项内）、
  Tab/Shift-Tab 缩进层级；`# `/`> `/```` ``` ````/`---`
  采用缓冲式确认（标记浅色预览、标题文字加粗，回车后正式转换）；
  `**x**`、`*x*`、`` `x` ``、`~~x~~`、`[x](url)` 闭合即应用样式；Ctrl+K 编辑链接；
  粘贴图片自动存入文档目录 `assets/`；从文件夹拖入图片：目录内转相对路径、
  目录外用绝对路径
- **源码**：CodeMirror 6 纯文本编辑
- **阅读**：只读渲染视图

模式切换时保持之前的滚动视图位置（按比例恢复，不回到顶部）。

### 状态栏

极简设计（与编辑区同宽），仅两个切换图标：

- `<` / `>`：显示 / 隐藏侧边栏
- `</>`：进入 / 退出源代码模式

文件名与保存状态已移至窗口标题栏展示，状态栏不再显示文字信息。

### 本地图片的显示授权

打开引用了**文档目录外**本地图片（绝对路径）的文档时，会出现询问横幅，
逐张列出待确认的图片，支持**逐张允许**或**全部允许**；授权按路径持久记忆
（应用数据目录 `image-grants.json`，上限 200 条），重启后不再询问。

## 环境要求

- Node.js ≥ 20，npm ≥ 10
- **Rust（stable-msvc）** 与 **VS C++ Build Tools**（Tauri Windows 构建链）
- Windows 构建依赖 WebView2 运行时（Win10/11 一般自带；安装包亦内置引导）

首次安装：

```bash
npm install
```

Rust 依赖经 crates.io 拉取；如需镜像可在 `~/.cargo/config.toml` 配置
rsproxy 等国内源。

## 日常开发与测试

```bash
npm run dev          # 开发模式（tauri dev：Vite 渲染端 + Rust 主进程）
npm run typecheck    # 渲染端 TypeScript 类型检查
npm test             # Vitest 单元测试（tests/unit，渲染端与 Markdown 管线）
npm run test:rust    # Rust 主进程单元测试（cargo test，路径策略等）
npm run build        # 渲染端 Vite 构建（产出 dist/）
npm run smoke        # 冒烟测试：启动打包产物，CDP 验证打开/标题/列表/图片授权
npm run dist         # 打包 NSIS 安装包（src-tauri/target/release/bundle/nsis/）
```

冒烟测试需要先 `npm run dist` 生成可执行文件；它通过 WebView2 的远程调试
端口（CDP）连接应用做端到端验证。

## 制作安装包

### Windows（本机）

```bash
npm run dist
```

产物：`src-tauri/target/release/bundle/nsis/MarkDesk-<版本号>-x64.exe`
（约 4 MB，NSIS、按用户安装、支持 .md/.markdown 文件关联）。

### Linux / macOS

跨平台编译不可行（macOS 工具链只在 macOS 上运行，Linux 需要链接
webkit2gtk 等系统库），两个平台的构建经 GitHub Actions 完成：

- 推送 `v*` 标签（如 `git tag v0.5.0 && git push origin v0.5.0`）自动
  构建 Windows/Linux/macOS 三平台并发布 GitHub Release
- 也可在 Actions 页面手动触发（workflow_dispatch），产物在 Artifacts

Linux 产物为 `.deb` 与 `.AppImage`；macOS 产物为 `.dmg`（当前为
Apple Silicon 架构）。本机 Linux 构建需先安装
`libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev
librsvg2-dev build-essential` 等依赖。

> 平台能力说明：PDF/图像导出依赖 WebView2 的 CDP，**当前仅 Windows
> 可用**；macOS/Linux 上这两项会提示暂不支持，HTML 与 Pandoc 导出
> 三平台一致。

打包行为定义在 `src-tauri/tauri.conf.json`；应用图标源为
`src-tauri/icons/`（可用 `npx tauri icon <png>` 重新生成）。
修改版本号请同步编辑 `package.json`、`src-tauri/tauri.conf.json` 与
`src-tauri/Cargo.toml` 的版本字段（当前均为 0.5.0）。

## 安全基线

以下配置是产品红线，任何构建都不得为了便利而削弱：

- 界面运行在系统 WebView 中，无 Node 集成；只能通过 `src/main/platform/`
  的窄接口（`MarkDeskRendererApi` → Rust invoke 命令）访问文件系统，
  且文档必须先经对话框/最近打开/argv 授权
- 本地图片仅能通过受限的 `markdesk-resource` 协议加载（WebView2 上为
  `http://markdesk-resource.localhost/`）：文档目录内的相对资源直接放行
  （规范化后不得逃逸目录），目录外的绝对路径图片仅在用户显式授权后显示
- HTML 导出经 DOMPurify 白名单净化；CSP 由 `tauri.conf.json` 与
  `index.html` 双向声明（`script-src 'self'`，无 unsafe-eval）

## 项目结构

```
src-tauri/        Rust 主进程：路径策略、受限资源协议、文件服务、菜单、
                  导出（含 WebView2 CDP 的 PDF/图像渲染）、关闭保护
src/main/         渲染进程：React 应用、WYSIWYG/源码/阅读三模式、
                  平台适配层（platform/）、状态、导出
src/markdown/     Markdown 管线：markdown-it → ProseMirror 模型 → 稳定序列化
src/shared/       渲染端与主进程共享的接口契约（类型、通道语义）
tests/unit/       Vitest 单元测试（渲染端与管线）
tests/tauri/      冒烟测试（CDP 驱动打包产物）
```
