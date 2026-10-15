export interface MarkDeskWindowTarget {
  isFocused(): boolean;
  isDestroyed(): boolean;
}

export function resolveFocusedMarkDeskWindow<
  TWindow extends MarkDeskWindowTarget,
>(windows: readonly TWindow[]): TWindow | null {
  return windows.find((window) => !window.isDestroyed() && window.isFocused()) ??
    null;
}
