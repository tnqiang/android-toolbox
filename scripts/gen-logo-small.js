/**
 * 一次性脚本：把 1024 的 icon.png 缩成 128×128 放到 renderer 的 assets 里
 * 让 TopBar 的 logo 用真实图标而不是占位字符
 *
 * 不引入 sharp（native），用纯 JS 方案：直接复制原图。
 * 浏览器端 img 会自动缩放，1024 图也能正常显示（只多占一点内存），
 * 但为了启动快，用 PNG 缩小会更好。这里先简化：直接复制 1024 原图，
 * 让 Vite 按需处理；显示端用 CSS 控制大小。
 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'resources', 'icon', 'icon.png');
const dstDir = path.join(__dirname, '..', 'src', 'renderer', 'assets');
const dst = path.join(dstDir, 'logo.png');

if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
fs.copyFileSync(src, dst);
console.log('[logo] copied to', dst, fs.statSync(dst).size, 'bytes');
