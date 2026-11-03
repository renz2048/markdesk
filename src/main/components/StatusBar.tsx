import type { EditorMode } from "../state/documentStore";

/**
 * 底栏（Typora 式极简 footer）：文件名与保存状态已移至窗口标题栏，
 * 这里只保留两个切换——侧栏显隐与源码模式进出。
 */
export function StatusBar({
  mode,
  sidebarVisible,
  onToggleSidebar,
  onToggleSourceMode,
}: {
  mode: EditorMode;
  sidebarVisible: boolean;
  onToggleSidebar(): void;
  onToggleSourceMode(): void;
}) {
  const sourceModeActive = mode === "source";
  return (
    <footer className="status-bar" data-testid="status-bar">
      <button
        type="button"
        className="status-bar-button"
        data-testid="toggle-sidebar"
        aria-pressed={sidebarVisible ? "true" : "false"}
        title={sidebarVisible ? "隐藏侧边栏" : "显示侧边栏"}
        aria-label={sidebarVisible ? "隐藏侧边栏" : "显示侧边栏"}
        onClick={onToggleSidebar}
      >
        {sidebarVisible ? ">" : "<"}
      </button>
      <button
        type="button"
        className="status-bar-button"
        data-testid="toggle-source-mode"
        aria-pressed={sourceModeActive ? "true" : "false"}
        title={sourceModeActive ? "退出源代码模式" : "启用源代码模式"}
        aria-label={sourceModeActive ? "退出源代码模式" : "启用源代码模式"}
        onClick={onToggleSourceMode}
      >
        {"</>"}
      </button>
    </footer>
  );
}
