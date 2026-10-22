import { describe, expect, it } from "vitest";
import { markdownPathFromArgv } from "../../src/electron/argv";

describe("markdownPathFromArgv", () => {
  it("returns the first markdown positional after the executable", () => {
    expect(
      markdownPathFromArgv([
        "C:\\Users\\me\\AppData\\MarkDesk.exe",
        "C:\\Users\\me\\notes\\readme.md",
      ]),
    ).toBe("C:\\Users\\me\\notes\\readme.md");
  });

  it("accepts WSL UNC paths", () => {
    expect(
      markdownPathFromArgv([
        "MarkDesk.exe",
        "\\\\wsl.localhost\\Ubuntu-22.04\\home\\dev\\notes\\todo.md",
      ]),
    ).toBe("\\\\wsl.localhost\\Ubuntu-22.04\\home\\dev\\notes\\todo.md");
  });

  it("skips switches such as --user-data-dir", () => {
    expect(
      markdownPathFromArgv([
        "MarkDesk.exe",
        "--user-data-dir=C:\\temp\\profile",
        "D:\\docs\\plan.markdown",
      ]),
    ).toBe("D:\\docs\\plan.markdown");
  });

  it("ignores non-markdown positionals", () => {
    expect(
      markdownPathFromArgv(["MarkDesk.exe", "C:\\docs\\report.txt"]),
    ).toBeNull();
  });

  it("requires an absolute path", () => {
    expect(markdownPathFromArgv(["MarkDesk.exe", "notes/todo.md"])).toBeNull();
  });

  it("returns null when no file argument is present", () => {
    expect(markdownPathFromArgv(["MarkDesk.exe"])).toBeNull();
    expect(markdownPathFromArgv([])).toBeNull();
  });
});
