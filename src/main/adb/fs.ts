/**
 * adb 文件系统操作：用于"应用文档浏览器"
 *
 * 基于 adbkit 的 sync API（DeviceClient.readdir / stat / pull / push），
 * 走 adbd 的 sync 协议 —— 在 Android 11+ 上对 /sdcard/Android/data/<pkg>/
 * 仍有较好兼容性（shell ls 会被限制，但 sync 仍可用）。
 *
 * 注意 adbkit 返回的 Bluebird Promise，不要直接 await，用 Promise.resolve 包一下即可。
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { getAdbClient } from './client';

export interface RemoteEntry {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;        // bytes
  mtimeMs: number;     // ms
  mode: number;        // POSIX mode
}

/** 给任意 Promise 包上超时 */
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

/** 规范化远程路径：去尾斜杠（除了根目录） */
export function normalizeRemote(path: string): string {
  if (!path) return '/';
  const p = path.replace(/\\/g, '/');
  if (p === '/') return '/';
  return p.endsWith('/') ? p.slice(0, -1) : p;
}

/** 拼接远程路径 */
export function joinRemote(base: string, name: string): string {
  const b = normalizeRemote(base);
  if (b === '/') return `/${name}`;
  return `${b}/${name}`;
}

/** 获取上一级目录；根目录返回自己 */
export function parentRemote(path: string): string {
  const p = normalizeRemote(path);
  if (p === '/' || !p.includes('/')) return '/';
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}

/**
 * 列目录
 * @throws 带设备错误信息（permission denied / no such file 等）
 */
export async function listDir(deviceId: string, remotePath: string): Promise<RemoteEntry[]> {
  const client = getAdbClient();
  const device = client.getDevice(deviceId);
  const path = normalizeRemote(remotePath) || '/';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entries: any[] = await withTimeout(device.readdir(path), 20000, `readdir ${path}`);
  return entries
    .map((e) => {
      // adbkit Entry: { name, mode, size, mtime (Date) }
      const mode = Number(e.mode ?? 0);
      // POSIX: S_IFDIR = 0o040000, S_IFLNK = 0o120000
      const isDir = (mode & 0o170000) === 0o040000;
      const isSymlink = (mode & 0o170000) === 0o120000;
      const mtimeMs = e.mtime instanceof Date ? e.mtime.getTime() : Number(e.mtime ?? 0) * 1000;
      return {
        name: String(e.name),
        isDir,
        isSymlink,
        size: Number(e.size ?? 0),
        mtimeMs,
        mode,
      } satisfies RemoteEntry;
    })
    // 过滤掉 '.' 和 '..'
    .filter((e) => e.name !== '.' && e.name !== '..')
    // 目录优先、同类按名称
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

/**
 * 拉文件到本地
 * @param onProgress 可选进度回调 bytesTransferred -> void
 */
export async function pullFile(
  deviceId: string,
  remotePath: string,
  localPath: string,
  onProgress?: (bytes: number, totalBytes?: number) => void,
  totalBytesHint?: number,
): Promise<void> {
  const client = getAdbClient();
  const device = client.getDevice(deviceId);

  // 确保本地父目录存在
  const parent = dirname(localPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const transfer: any = await withTimeout(
    device.pull(remotePath),
    20000,
    `pull ${remotePath}`,
  );

  return new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(localPath);
    let bytes = 0;
    transfer.on('progress', (stats: { bytesTransferred: number }) => {
      bytes = stats.bytesTransferred;
      onProgress?.(bytes, totalBytesHint);
    });
    transfer.on('end', () => {
      onProgress?.(bytes, totalBytesHint);
      resolve();
    });
    transfer.on('error', reject);
    ws.on('error', reject);
    transfer.pipe(ws);
  });
}

/**
 * 推本地文件到设备
 */
export async function pushFile(
  deviceId: string,
  localPath: string,
  remotePath: string,
  onProgress?: (bytes: number, totalBytes?: number) => void,
): Promise<void> {
  const client = getAdbClient();
  const device = client.getDevice(deviceId);

  const stat = statSync(localPath);
  const total = stat.size;

  // adbkit 支持传 Readable stream 或本地路径字符串
  const stream = createReadStream(localPath);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const transfer: any = await withTimeout(
    device.push(stream, remotePath, 0o644),
    20000,
    `push -> ${remotePath}`,
  );

  return new Promise<void>((resolve, reject) => {
    transfer.on('progress', (stats: { bytesTransferred: number }) => {
      onProgress?.(stats.bytesTransferred, total);
    });
    transfer.on('end', () => {
      onProgress?.(total, total);
      resolve();
    });
    transfer.on('error', reject);
  });
}

// ================== 需要 shell 辅助的操作 ==================

import { AdbUtil } from './client';

async function shellCollect(deviceId: string, cmd: string, timeoutMs = 10000): Promise<string> {
  const client = getAdbClient();
  const device = client.getDevice(deviceId);
  const stream = await withTimeout(device.shell(cmd), timeoutMs, `shell(${cmd.slice(0, 40)})`);
  const buf: Buffer = await withTimeout(
    AdbUtil.readAll(stream),
    timeoutMs,
    `readAll(${cmd.slice(0, 40)})`,
  );
  return buf.toString('utf8');
}

/** shell 参数转义：把单引号包裹 */
function shq(p: string): string {
  // 单引号包裹内部的单引号替换为 '\''
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** 新建目录（允许已存在） */
export async function mkdirRemote(deviceId: string, remotePath: string): Promise<void> {
  const out = await shellCollect(deviceId, `mkdir -p ${shq(remotePath)} 2>&1; echo __RC__=$?`, 10000);
  const m = out.match(/__RC__=(\d+)/);
  const rc = m ? Number(m[1]) : -1;
  if (rc !== 0) {
    throw new Error(`mkdir failed: ${out.replace(/__RC__=\d+/, '').trim()}`);
  }
}

/** 删除文件或目录（递归） */
export async function removeRemote(deviceId: string, remotePath: string): Promise<void> {
  const out = await shellCollect(deviceId, `rm -rf ${shq(remotePath)} 2>&1; echo __RC__=$?`, 15000);
  const m = out.match(/__RC__=(\d+)/);
  const rc = m ? Number(m[1]) : -1;
  if (rc !== 0) {
    throw new Error(`rm failed: ${out.replace(/__RC__=\d+/, '').trim()}`);
  }
}

/** 重命名/移动 */
export async function renameRemote(
  deviceId: string,
  from: string,
  to: string,
): Promise<void> {
  const out = await shellCollect(
    deviceId,
    `mv ${shq(from)} ${shq(to)} 2>&1; echo __RC__=$?`,
    10000,
  );
  const m = out.match(/__RC__=(\d+)/);
  const rc = m ? Number(m[1]) : -1;
  if (rc !== 0) {
    throw new Error(`mv failed: ${out.replace(/__RC__=\d+/, '').trim()}`);
  }
}

/**
 * 判断远程路径是否存在且是目录（用于访问被拒时的探测）
 * 返回：'dir' | 'file' | 'notfound' | 'denied'
 */
export async function probeRemote(
  deviceId: string,
  remotePath: string,
): Promise<'dir' | 'file' | 'notfound' | 'denied'> {
  const out = await shellCollect(
    deviceId,
    `ls -ld ${shq(remotePath)} 2>&1; echo __RC__=$?`,
    8000,
  );
  const m = out.match(/__RC__=(\d+)/);
  const rc = m ? Number(m[1]) : -1;
  const low = out.toLowerCase();
  if (rc !== 0) {
    if (/permission denied/.test(low)) return 'denied';
    if (/no such/.test(low)) return 'notfound';
    return 'notfound';
  }
  // 成功，首字母 d 表示目录
  const firstLine = out.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  return firstLine.startsWith('d') ? 'dir' : 'file';
}
