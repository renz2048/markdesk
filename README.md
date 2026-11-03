# MarkDesk

MarkDesk 是一个安全的单文件 Markdown 阅读器与编辑器（Electron + React + ProseMirror +
CodeMirror 6）。渲染进程运行在严格沙箱中（`contextIsolation` / `sandbox` / 无 Node 集成），
所有文件访问都经过主进程校验的 IPC 通道；保存采用临时文件 + 原子替换，并带外部修改检测、
恢复草稿与净化后的 HTML 导出。

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
- **主题**：浅色 / 深色 / 跟随系统（单选，对应 Typora github / night 两套配色）

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

## 环境要求

- Node.js ≥ 20，npm ≥ 10
- Linux 打包需要图形库（WSL 下建议 WSLg）；运行 e2e 测试需要可用的 X 显示
- 首次安装：

  ```bash
  npm install
  ```

  npm 12+ 会询问是否放行 `electron` / `esbuild` 的安装脚本（本仓库的 `package.json`
  已通过 `allowScripts` 预先批准）。若网络访问 GitHub 受限，先设置 Electron 二进制镜像：

  ```bash
  export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  ```

## 日常开发与测试

```bash
npm run dev          # 开发模式（Vite 渲染端 + Electron 并行启动）
npm run typecheck    # 渲染端与主进程两个 tsconfig 的类型检查
npm test             # Vitest 单元测试（tests/unit）
npm run e2e          # 构建 + Playwright Electron 端到端测试（tests/e2e）
npm run build        # preload 打包（esbuild）+ 主进程 tsc + 渲染端 Vite 构建
```

e2e 在受限环境（如 WSLg）下建议单 worker 串行执行（`playwright.config.ts` 已配置），
并以每条测试的结果为准。

## 在 Linux 上运行

打包完成后有三种打开方式（按推荐顺序）：

**方式一：解包目录（免安装、免 FUSE，最稳）**

```bash
./release/linux-unpacked/markdesk --disable-gpu
```

**方式二：AppImage**

```bash
chmod +x release/MarkDesk-<版本号>.AppImage
./release/MarkDesk-<版本号>.AppImage --disable-gpu
```

在 WSL 或未安装 FUSE 的系统上会报 `libfuse.so.2` 缺失。两种解决办法任选：

```bash
# 办法 A：安装 libfuse2 后直接运行
sudo apt install libfuse2

# 办法 B：解压后运行（无需任何权限）
./release/MarkDesk-<版本号>.AppImage --appimage-extract
./squashfs-root/markdesk --disable-gpu
```

**方式三：开发模式（从源码运行）**

```bash
npm run dev
```

说明：`--disable-gpu` 不是必须的，但在 WSLg / 无硬件显卡的环境下强烈建议加上——
否则 GPU 子进程的崩溃会级联拖垮 network/zygote 服务导致窗口偶发失灵（本项目
e2e 测试也统一使用该参数）。

## 制作安装包

所有平台的产物都输出到 `release/` 目录，由 [electron-builder](https://electron.build) 完成。

### 网络受限时先设置镜像（推荐）

electron-builder 打包时需要下载对应平台的 Electron 运行时与打包工具链，默认源是
GitHub Releases。若直连不畅，设置以下环境变量（Linux/macOS 用 `export`，
Windows PowerShell 用 `$env:`，CMD 用 `set`）：

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
```

### Linux（AppImage）

在 Linux 主机上直接执行：

```bash
npm run dist
```

产物：`release/MarkDesk-<版本号>.AppImage`（免安装，`chmod +x` 后可直接运行）。
同时会生成 `release/linux-unpacked/markdesk` 可执行目录。

### Windows（NSIS 安装程序）

**推荐：在 Windows 主机上打包**（安装 Node.js 后执行同样步骤）：

```powershell
npm install
npm run dist -- --win
```

产物：`release/MarkDesk-<版本号>-x64.exe`（NSIS 安装程序，支持自定义安装目录）。

**在 Linux 上交叉打包 Windows 版**需要 [wine](https://www.winehq.org/)（electron-builder
用它改写 Windows 可执行文件的资源与图标）：

```bash
# Debian/Ubuntu（需要 sudo）
sudo apt install wine64

npm run dist -- --win
```

没有 wine 时，交叉打包会在 `wine is required` 处失败——这是 electron-builder 的
通用限制，与本项目代码无关。

### macOS（DMG）

在 macOS 主机上：

```bash
npm run dist -- --mac
```

产物：`release/MarkDesk-<版本号>.dmg`。（对应用户直接分发的构建需要 Apple 开发者
签名/公证配置，本项目未内置。）

## 打包配置

打包行为定义在 `electron-builder.yml`：`appId`、目标平台（NSIS / AppImage / DMG）、
asar 打包、以及应用图标 `build/icon.png`（1024×1024，可用
`node scripts/generate-icon.mjs` 重新生成）。修改版本号请编辑 `package.json` 的
`version` 字段。

## 安全基线

以下配置是产品红线，任何构建都不得为了便利而削弱：

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`
- 渲染进程只能通过 `window.markdesk`（`src/shared/types.ts` 中定义的窄接口）访问文件系统
- HTML 导出经 DOMPurify 白名单净化；本地图片仅能通过受限的 `markdesk-resource:` 协议
  加载：文档目录内的相对资源直接放行（不得逃逸目录），目录外的绝对路径图片仅在
  用户显式授权（拖入时登记，或打开文档时确认一次）后显示，授权按路径持久记忆
  （`userData/image-grants.json`，上限 200 条）

## 项目结构

```
src/electron/    主进程：安全配置、IPC 校验、文件服务、最近文件、恢复草稿、菜单
src/main/        渲染进程：React 应用、WYSIWYG/源码/阅读三模式、状态、导出
src/markdown/    Markdown 管线：markdown-it → ProseMirror 模型 → 稳定序列化
src/shared/      渲染端与主进程共享的 IPC 契约（通道名、类型、结果联合）
tests/unit/      Vitest 单元测试（主进程逻辑通过依赖注入测试，不启动 Electron）
tests/e2e/       Playwright Electron 端到端测试（生命周期、恢复、安全、模式）
```

详细设计见仓库外层工作区的 `docs/superpowers/specs/2026-10-15-markdesk-design.md`。
