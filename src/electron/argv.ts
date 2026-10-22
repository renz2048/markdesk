import { isMarkdownPath } from "./file-service";

// Explorer 的“打开方式”与命令行启动都会把文件路径追加到 argv 末尾。
// 这里跳过可执行文件与 Electron/Chromium 开关（如 --user-data-dir=），
// 返回第一个通过 Markdown 路径校验的位置参数；UNC 路径（例如
// \\wsl.localhost\Ubuntu\home\dev\notes\todo.md）同样按绝对路径接受。
export function markdownPathFromArgv(argv: readonly string[]): string | null {
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith("-")) continue;
    if (isMarkdownPath(argument)) return argument;
  }
  return null;
}
