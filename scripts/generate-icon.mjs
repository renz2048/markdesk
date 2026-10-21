// 生成 build/icon.png：1024×1024 的应用图标（深蓝底、白色 M 字折线）。
// 纯 Node 实现（zlib + 手写 PNG 块），避免外部图像工具依赖。
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 1024;
const BACKGROUND = [23, 32, 51]; // #172033，与应用深色主题一致
const FOREGROUND = [238, 242, 248]; // #eef2f8

function crc32(bytes) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBytes = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

// M 字折线：左竖线、右竖线，以及从两条竖线顶部下探到中部谷底的 V 形。
function strokePixel(x, y) {
  const inset = 168; // 竖线与画布边缘的距离
  const width = 104; // 线宽
  const top = 264;
  const bottom = 760;
  const valleyY = 560; // V 形谷底

  // 左右竖线
  if (x >= inset && x < inset + width && y >= top && y <= bottom) return true;
  if (
    x >= SIZE - inset - width &&
    x < SIZE - inset &&
    y >= top &&
    y <= bottom
  ) {
    return true;
  }

  // V 形：中心线 y 随 x 从竖线顶（top）下探到中部谷底（valleyY）。
  const innerLeft = inset + width / 2;
  const innerRight = SIZE - inset - width / 2;
  if (x >= innerLeft && x <= innerRight) {
    const half = Math.abs(x - SIZE / 2) / (SIZE / 2 - innerLeft);
    const centerY = top + (valleyY - top) * (1 - half);
    if (y >= centerY && y <= centerY + width) return true;
  }
  return false;
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1), 0);
for (let y = 0; y < SIZE; y += 1) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0; // filter: none
  for (let x = 0; x < SIZE; x += 1) {
    const offset = rowStart + 1 + x * 4;
    const [r, g, b] = strokePixel(x, y) ? FOREGROUND : BACKGROUND;
    raw[offset] = r;
    raw[offset + 1] = g;
    raw[offset + 2] = b;
    raw[offset + 3] = 0xff;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const outPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "build",
  "icon.png",
);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, png);
console.log(`icon written: ${outPath} (${png.length} bytes)`);
