import { describe, expect, it } from "vitest";
import { resolveFocusedMarkDeskWindow } from "../../src/electron/menu-target";

class FakeWindow {
  constructor(
    readonly id: number,
    private readonly focused = false,
    private readonly destroyed = false,
  ) {}

  isFocused(): boolean {
    return this.focused;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

describe("application menu targeting", () => {
  it("selects the currently focused live MarkDesk window", () => {
    const first = new FakeWindow(1);
    const second = new FakeWindow(2, true);

    expect(resolveFocusedMarkDeskWindow([first, second])).toBe(second);
  });

  it("does not fall back when the focused window has been destroyed", () => {
    const destroyed = new FakeWindow(1, true, true);
    const live = new FakeWindow(2);

    expect(resolveFocusedMarkDeskWindow([destroyed, live])).toBeNull();
  });

  it("returns null rather than falling back to an unfocused window", () => {
    const first = new FakeWindow(1);
    const second = new FakeWindow(2);

    expect(resolveFocusedMarkDeskWindow([first, second])).toBeNull();
  });
});
