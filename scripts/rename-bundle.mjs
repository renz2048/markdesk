// 把 NSIS 产物名去掉 -setup 后缀（Tauri 固定追加，配置项不可改）：
// MarkDesk_0.3.0_x64-setup.exe → MarkDesk_0.3.0_x64.exe
import { readdir, rename } from "node:fs/promises";
import { join } from "node:path";

const bundleDir = join(process.cwd(), "src-tauri/target/release/bundle/nsis");
const entries = await readdir(bundleDir);
const setupExe = entries.find(
  (name) => /^MarkDesk_.*-setup\.exe$/u.test(name),
);
if (!setupExe) {
  console.error(`未找到 *-setup.exe（目录：${bundleDir}）`);
  process.exit(1);
}
const renamed = setupExe.replace("-setup.exe", ".exe");
await rename(join(bundleDir, setupExe), join(bundleDir, renamed));
console.log(`renamed: ${setupExe} -> ${renamed}`);
