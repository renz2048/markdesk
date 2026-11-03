import type { ElectronApplication } from "@playwright/test";

/**
 * 在主进程侧点击原生菜单项（与真实菜单交互等价的命令分发路径）。
 * 视图栏移除后，文件/模式/主题操作均经原生菜单完成。
 */
export async function clickMenuItem(
  app: ElectronApplication,
  menuLabel: string,
  itemLabel: string,
): Promise<void> {
  await app.evaluate(
    ({ Menu }, { menuLabel: m, itemLabel: i }) => {
      const menu = Menu.getApplicationMenu();
      const submenu = menu?.items.find((item) => item.label === m)?.submenu;
      submenu?.items.find((item) => item.label === i)?.click();
    },
    { menuLabel, itemLabel },
  );
}

/** 读取顶层菜单标签，用于断言菜单结构。 */
export async function topLevelMenuLabels(
  app: ElectronApplication,
): Promise<string[]> {
  return app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    return (menu?.items ?? []).map((item) => item.label);
  });
}
