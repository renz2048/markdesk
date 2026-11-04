// 规范 NSIS 产物名：去掉 Tauri 固定追加的 -setup 后缀，并把下划线
// 换成连字符，与历史命名一致：
// MarkDesk_0.4.0_x64-setup.exe → MarkDesk-0.4.0-x64.exe
import { readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

const bundleDir = join(process.cwd(), "src-tauri/target/release/bundle/nsis");
const entries = await readdir(bundleDir);
const candidates = entries.filter((name) =>
  /^MarkDesk_.*x64(-setup)?\.exe$/u.test(name),
);
if (candidates.length === 0) {
  console.error(`未找到 MarkDesk 安装包（目录：${bundleDir}）`);
  process.exit(1);
}
// 目录可能残留旧版本产物，取修改时间最新的一个。
let current = candidates[0];
let newest = (await stat(join(bundleDir, current))).mtimeMs;
for (const name of candidates.slice(1)) {
  const mtime = (await stat(join(bundleDir, name))).mtimeMs;
  if (mtime > newest) {
    newest = mtime;
    current = name;
  }
}
const target = current.replace("-setup.exe", ".exe").replace(/_/gu, "-");
if (current === target) {
  console.log(`already named: ${target}`);
} else {
  await rename(join(bundleDir, current), join(bundleDir, target));
  console.log(`renamed: ${current} -> ${target}`);
}
