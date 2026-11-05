// 规范 NSIS 产物名：去掉 Tauri 固定追加的 -setup 后缀，
// 保留 Tauri 默认的下划线风格（与 deb/AppImage/dmg 一致）：
// MarkDesk_0.5.0_x64-setup.exe → MarkDesk_0.5.0_x64.exe
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
const target = current.replace("-setup.exe", ".exe");
if (current === target) {
  console.log(`already named: ${target}`);
} else {
  await rename(join(bundleDir, current), join(bundleDir, target));
  console.log(`renamed: ${current} -> ${target}`);
}
