/**
 * 媒体扫描与本地缓存：用于"相册"功能（图片预览/拷贝）
 *
 * 思路：
 *   1. 用 adb shell find 扫描设备上几个典型相册根目录（DCIM/Pictures/Screenshots）
 *      只列图片扩展名；按 mtime 排序由调用方处理。
 *   2. 拉文件到 PC 本地的"媒体缓存目录" -> 让渲染层用 file:// 直接预览。
 *      文件名用 sha1(devicePath + mtime + size) + 原扩展名 防冲突 + 实现"内容不变就直接命中"。
 *   3. 限制单文件最大缓存大小；定期不做清理（缓存目录在 app.getPath('userData')/media-cache 下，由用户/卸载清理）。
 */
import { app } from 'electron';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { AdbUtil, getAdbClient } from './client';
import { pullFile } from './fs';

/** 支持的图片扩展名（小写） */
export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];

/** 默认扫描的相册根目录（按需在 UI 暴露） */
const DEFAULT_IMAGE_ROOTS = [
  '/sdcard/DCIM',
  '/sdcard/Pictures',
];

export interface MediaEntry {
  /** 设备上的绝对路径 */
  path: string;
  /** 文件名（含扩展名） */
  name: string;
  /** 字节 */
  size: number;
  /** 修改时间（ms） */
  mtimeMs: number;
  /** 扩展名（小写、无点） */
  ext: string;
}

/** 给 Promise 加超时 */
function withTimeout<T>(p: PromiseLike<T>, ms: number, label = 'op'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout after ${ms}ms: ${label}`)),
      ms,
    );
    Promise.resolve(p).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function shellCollect(deviceId: string, cmd: string, timeoutMs = 30000): Promise<string> {
  const client = getAdbClient();
  const device = client.getDevice(deviceId);
  const stream = await withTimeout(device.shell(cmd), timeoutMs, `shell(${cmd.slice(0, 50)})`);
  const buf: Buffer = await withTimeout(
    AdbUtil.readAll(stream),
    timeoutMs,
    `readAll(${cmd.slice(0, 50)})`,
  );
  return buf.toString('utf8');
}

/** shell 字符串转义 */
function shq(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * 扫描设备上的图片文件。
 *
 * 用一条 find -printf 输出  size\tmtime\tpath  三列，性能远好于 ls。
 * 部分老安卓的 toybox find 不支持 -printf；走兼容回退 stat -c。
 *
 * @param roots  要扫描的设备目录列表；为空时用默认。
 * @param exts   扩展名过滤（小写、无点）；为空时用 IMAGE_EXTS。
 */
export async function scanMedia(
  deviceId: string,
  roots: string[] = DEFAULT_IMAGE_ROOTS,
  exts: string[] = IMAGE_EXTS,
): Promise<MediaEntry[]> {
  if (!roots.length) return [];
  const extLower = exts.map((e) => e.toLowerCase().replace(/^\./, ''));
  if (extLower.length === 0) return [];

  // 构造 find 表达式： -iname '*.jpg' -o -iname '*.png' ...
  const nameExpr = extLower
    .map((e) => `-iname '*.${e}'`)
    .join(' -o ');

  // -printf 输出: size<TAB>mtime_epoch<TAB>full_path<NL>
  // 注意：toybox find 支持 -printf "%s\t%T@\t%p\n"
  const rootExpr = roots.map(shq).join(' ');
  const findCmd =
    `find ${rootExpr} -type f \\( ${nameExpr} \\) ` +
    `-printf '%s\\t%T@\\t%p\\n' 2>/dev/null`;

  const t0 = Date.now();
  let out = '';
  try {
    out = await shellCollect(deviceId, findCmd, 60_000);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[media] find with -printf failed, will fall back:', e);
    out = '';
  }

  const entries: MediaEntry[] = [];

  // 解析 -printf 输出
  if (out.includes('\t')) {
    const lines = out.split('\n');
    for (const line of lines) {
      if (!line) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const size = Number(parts[0]);
      const mtime = parseFloat(parts[1]);
      const fpath = parts.slice(2).join('\t').trim();
      if (!fpath || !Number.isFinite(size)) continue;
      const name = fpath.split('/').pop() || fpath;
      const dot = name.lastIndexOf('.');
      const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
      entries.push({
        path: fpath,
        name,
        size,
        mtimeMs: Number.isFinite(mtime) ? Math.round(mtime * 1000) : 0,
        ext,
      });
    }
  }

  // 兜底：没有结果时用更轻量的 find -print 再 stat
  if (entries.length === 0) {
    const findCmdLite =
      `find ${rootExpr} -type f \\( ${nameExpr} \\) 2>/dev/null`;
    const out2 = await shellCollect(deviceId, findCmdLite, 60_000).catch(() => '');
    const files = out2.split('\n').map((l) => l.trim()).filter(Boolean);
    if (files.length > 0) {
      // 单次 stat 批量，分批 200 个
      const BATCH = 200;
      for (let i = 0; i < files.length; i += BATCH) {
        const slice = files.slice(i, i + BATCH);
        const statCmd =
          `stat -c '%s %Y %n' ${slice.map(shq).join(' ')} 2>/dev/null`;
        const sOut = await shellCollect(deviceId, statCmd, 30_000).catch(() => '');
        for (const line of sOut.split('\n')) {
          if (!line) continue;
          const m = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
          if (!m) continue;
          const size = Number(m[1]);
          const mtime = Number(m[2]) * 1000;
          const fpath = m[3].trim();
          const name = fpath.split('/').pop() || fpath;
          const dot = name.lastIndexOf('.');
          const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
          entries.push({ path: fpath, name, size, mtimeMs: mtime, ext });
        }
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(`[media] scanMedia found=${entries.length} in ${Date.now() - t0}ms roots=${roots.join(',')}`);

  // 按 mtime 倒序（最近的在前）
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries;
}

// ----------------- 本地缓存：把设备文件拉到 PC，让 webview 用 file:// 预览 -----------------

let cacheRootCached: string | null = null;
function getCacheRoot(): string {
  if (cacheRootCached) return cacheRootCached;
  const base = app.getPath('userData');
  const root = join(base, 'media-cache');
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  cacheRootCached = root;
  return root;
}

/** 缓存文件名：hash(deviceId+path+mtime+size) + 原扩展名 */
function cacheNameFor(deviceId: string, entry: { path: string; mtimeMs: number; size: number }): string {
  const h = createHash('sha1')
    .update(`${deviceId}|${entry.path}|${entry.mtimeMs}|${entry.size}`)
    .digest('hex');
  const dot = entry.path.lastIndexOf('.');
  const ext = dot >= 0 ? entry.path.slice(dot).toLowerCase() : '';
  return `${h}${ext}`;
}

/**
 * 按需从设备 pull 到本地缓存目录；已缓存则直接返回。
 *
 * 并发控制：调用方控制；这里同一文件并行调用会串行化（用 inFlight Map）。
 */
const inFlight = new Map<string, Promise<string>>();

export async function ensureLocalCache(
  deviceId: string,
  entry: { path: string; mtimeMs: number; size: number },
): Promise<string> {
  const cacheRoot = getCacheRoot();
  const file = join(cacheRoot, cacheNameFor(deviceId, entry));

  if (existsSync(file)) {
    try {
      const st = statSync(file);
      // size 一致即视为命中（mtime 已编入文件名）
      if (st.size === entry.size || entry.size === 0) {
        return file;
      }
    } catch { /* 落到重新 pull */ }
  }

  const key = file;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const p = (async () => {
    try {
      await pullFile(deviceId, entry.path, file);
      return file;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, p);
  return p;
}

/**
 * 暴露给渲染进程：拿到一个可直接通过 <img src> / <video src> 加载的 file://path
 * 注意：webview 端通过 BrowserWindow 的 webSecurity=true（默认）也可以加载 file://
 * 但有些资源加载限制时建议用 app:// 协议；这里项目内已经有 file:// 用法（截图保存等），沿用即可。
 */
export async function getLocalUrlForMedia(
  deviceId: string,
  entry: { path: string; mtimeMs: number; size: number },
): Promise<string> {
  const local = await ensureLocalCache(deviceId, entry);
  // Windows 路径需要转 file:///
  const norm = local.replace(/\\/g, '/');
  const url = norm.startsWith('/') ? `file://${norm}` : `file:///${norm}`;
  return url;
}
