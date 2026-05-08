/**
 * 一次性脚本：把 resources/icon/icon.png 转成
 *   - resources/icon.ico   (Windows 多尺寸: 16/24/32/48/64/128/256)
 *   - resources/icon.icns  (macOS 多尺寸)
 *
 * 运行：node scripts/gen-icons.js
 * 依赖：png2icons（dev 临时装即可，不入 package.json）
 */
const fs = require('fs');
const path = require('path');
const png2icons = require('png2icons');

const src = path.join(__dirname, '..', 'resources', 'icon', 'icon.png');
const outIco = path.join(__dirname, '..', 'resources', 'icon.ico');
const outIcns = path.join(__dirname, '..', 'resources', 'icon.icns');

if (!fs.existsSync(src)) {
  console.error('[icons] source not found:', src);
  process.exit(1);
}
const buf = fs.readFileSync(src);
console.log('[icons] source size:', buf.length);

// BEZIER 是最好看的缩放算法
const ico = png2icons.createICO(buf, png2icons.BEZIER, 0, false);
if (ico) {
  fs.writeFileSync(outIco, ico);
  console.log('[icons] wrote', outIco, '(', ico.length, 'bytes )');
} else {
  console.error('[icons] createICO failed');
  process.exit(1);
}

const icns = png2icons.createICNS(buf, png2icons.BEZIER, 0);
if (icns) {
  fs.writeFileSync(outIcns, icns);
  console.log('[icons] wrote', outIcns, '(', icns.length, 'bytes )');
} else {
  console.error('[icons] createICNS failed');
  process.exit(1);
}

console.log('[icons] done');
