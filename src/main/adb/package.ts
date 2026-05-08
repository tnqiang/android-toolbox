/**
 * 应用（包）管理：列表、安装、卸载、导出 APK
 *
 * adbkit 3.x：通过 client.getDevice(serial) 拿到 DeviceClient 再操作
 * 注意：install 改走 child_process.spawn('adb', ...)，因为 adbkit 在大 APK 上不稳定
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs';
import { join, basename } from 'path';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { app } from 'electron';
import { getAdbClient, AdbUtil, resolveAdbBinary } from './client';
import type { AppInfo, AppCategory } from '../../shared/types';

/** detail 磁盘缓存目录 */
const DETAIL_CACHE_DIR = join(app.getPath('userData'), 'app-detail-cache');
function ensureDetailCacheDir() {
  if (!existsSync(DETAIL_CACHE_DIR)) mkdirSync(DETAIL_CACHE_DIR, { recursive: true });
}
/** 用 pkg + apkPath 作 key（同 pkg 不同 apkPath = 升级了） */
function detailCacheFile(packageName: string, apkPath?: string): string {
  const sig = createHash('md5').update(`${packageName}|${apkPath ?? ''}`).digest('hex').slice(0, 12);
  return join(DETAIL_CACHE_DIR, `${packageName}_${sig}.json`);
}
function readDetailCache(packageName: string, apkPath?: string): Partial<AppInfo> | null {
  ensureDetailCacheDir();
  const file = detailCacheFile(packageName, apkPath);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}
function writeDetailCache(packageName: string, apkPath: string | undefined, detail: Partial<AppInfo>) {
  ensureDetailCacheDir();
  try {
    writeFileSync(detailCacheFile(packageName, apkPath), JSON.stringify(detail));
  } catch { /* ignore */ }
}

/**
 * 删除某个包下所有 detail 缓存文件（覆盖安装后 apkPath 会变，旧缓存必然失效）
 */
export function clearDetailCacheForPackage(packageName: string) {
  ensureDetailCacheDir();
  try {
    const files = readdirSync(DETAIL_CACHE_DIR);
    for (const f of files) {
      if (f.startsWith(`${packageName}_`) && f.endsWith('.json')) {
        try { unlinkSync(join(DETAIL_CACHE_DIR, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

/** 给任意 Promise 包上超时（默认 15 秒） */
function withTimeout<T>(p: PromiseLike<T>, ms = 15000, label = 'op'): Promise<T> {
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

async function shellExec(deviceId: string, cmd: string, timeoutMs = 15000): Promise<string> {
  const client = getAdbClient();
  try {
    const stream = await withTimeout(
      client.getDevice(deviceId).shell(cmd),
      timeoutMs,
      `shell(${cmd.slice(0, 40)})`,
    );
    const buf: Buffer = await withTimeout(
      AdbUtil.readAll(stream),
      timeoutMs,
      `readAll(${cmd.slice(0, 40)})`,
    );
    return buf.toString('utf8');
  } catch (e) {
    // 出错时返回空串，让上层优雅降级而不是挂死
    // eslint-disable-next-line no-console
    console.warn(`[shell] ${deviceId} "${cmd.slice(0, 60)}" failed:`, (e as Error).message);
    return '';
  }
}

/**
 * 列出已安装应用（一次性拉全部，同时拿到系统应用名单，前端再按 isSystem 分类）
 *  -f 含 APK 路径  -s 仅系统（用来准确判定 isSystem）
 */
export async function listApps(
  deviceId: string,
  _category: AppCategory = 'all'
): Promise<AppInfo[]> {
  // 1) 全部应用
  const allOut = await shellExec(deviceId, 'pm list packages -f');
  // 2) 系统应用（独立查询）
  let systemSet = new Set<string>();
  try {
    const sysOut = await shellExec(deviceId, 'pm list packages -s');
    systemSet = new Set(
      sysOut
        .split(/\r?\n/)
        .map((l) => l.replace(/^package:/, '').trim())
        .filter((l) => !!l && !l.endsWith('.apk')),
    );
  } catch { /* ignore */ }

  const apps: AppInfo[] = [];
  for (const line of allOut.split(/\r?\n/)) {
    // 形如：package:/data/app/~~xxx==/com.example-xxx/base.apk=com.example
    const m = line.match(/^package:(.+\.apk)=([^\s]+)/);
    if (!m) continue;
    const apkPath = m[1];
    const packageName = m[2];
    // 优先以 pm list -s 的结果判定；fallback 用路径判定
    const isSystem = systemSet.has(packageName) || !apkPath.startsWith('/data/app/');
    apps.push({
      packageName,
      apkPath,
      isSystem,
    });
  }
  return apps;
}

/** 拉取单个包的版本/时间/大小等详细信息；带磁盘缓存（按 pkg+apkPath） */
export async function getAppDetail(
  deviceId: string,
  packageName: string,
  apkPath?: string,
): Promise<Partial<AppInfo>> {
  // 1) 缓存命中直接返回
  const cached = readDetailCache(packageName, apkPath);
  if (cached) return cached;

  // 2) 实际查询
  const out = await shellExec(deviceId, `dumpsys package ${packageName}`);
  const versionName = out.match(/versionName=([^\s]+)/)?.[1];
  const versionCode = out.match(/versionCode=(\d+)/)?.[1];
  const firstInstall = out.match(/firstInstallTime=([^\s]+)/)?.[1];
  const lastUpdate = out.match(/lastUpdateTime=([^\s]+)/)?.[1];
  const codePath = out.match(/codePath=([^\s]+)/)?.[1];

  // 取 APK 大小：stat -c %s <apkPath>/base.apk
  let apkSize: number | undefined;
  if (codePath) {
    try {
      const sz = await shellExec(deviceId, `stat -c %s ${codePath}/base.apk 2>/dev/null`);
      const n = parseInt(sz.trim(), 10);
      if (!Number.isNaN(n)) apkSize = n;
    } catch { /* 忽略 */ }
  }

  const detail: Partial<AppInfo> = {
    versionName,
    versionCode: versionCode ? Number(versionCode) : undefined,
    firstInstallTime: firstInstall ? Date.parse(firstInstall) || undefined : undefined,
    lastUpdateTime: lastUpdate ? Date.parse(lastUpdate) || undefined : undefined,
    apkSize,
  };
  // 3) 写缓存
  writeDetailCache(packageName, apkPath, detail);
  return detail;
}

/**
 * 批量读取多个包的 detail（仅返回缓存命中的）
 * 一次 IPC 解决多个 readFileSync，避免跨进程往返开销
 */
export function getAppDetailBatch(
  items: { packageName: string; apkPath?: string }[],
): { packageName: string; detail: Partial<AppInfo> }[] {
  const result: { packageName: string; detail: Partial<AppInfo> }[] = [];
  for (const it of items) {
    const cached = readDetailCache(it.packageName, it.apkPath);
    if (cached) result.push({ packageName: it.packageName, detail: cached });
  }
  return result;
}

/**
 * 一次 dumpsys diskstats 拿全部应用的数据/缓存大小（"文档大小"）
 * 返回 Map<packageName, dataSizeBytes>（dataSize + cacheSize 之和）
 *
 * dumpsys diskstats 输出含：
 *   Package Names: ["com.a","com.b",...]
 *   App Sizes: [123, 456, ...]            // APK + lib + obb 等
 *   App Data Sizes: [100, 200, ...]       // /data/data/<pkg>
 *   Cache Sizes: [10, 20, ...]            // 缓存
 */
export async function getAllAppDataSizes(deviceId: string): Promise<Record<string, number>> {
  const out = await shellExec(deviceId, 'dumpsys diskstats', 20000);
  if (!out) return {};

  // 抽取一个 [..,..,..] 数组字段
  const extractArr = (key: string): (string | number)[] | null => {
    const m = out.match(new RegExp(`${key}\\s*:\\s*\\[([^\\]]*)\\]`));
    if (!m) return null;
    const body = m[1].trim();
    if (!body) return [];
    // 字符串数组（带引号）或数字数组
    if (body.startsWith('"')) {
      // 简单 split by '","'
      return body
        .replace(/^"|"$/g, '')
        .split(/"\s*,\s*"/);
    }
    return body.split(/\s*,\s*/).map((s) => Number(s));
  };

  const names = extractArr('Package Names') as string[] | null;
  const dataSizes = extractArr('App Data Sizes') as number[] | null;
  const cacheSizes = extractArr('Cache Sizes') as number[] | null;

  if (!names || !dataSizes) return {};

  const map: Record<string, number> = {};
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const data = Number(dataSizes[i] ?? 0);
    const cache = Number(cacheSizes?.[i] ?? 0);
    if (!name) continue;
    map[name] = (Number.isFinite(data) ? data : 0) + (Number.isFinite(cache) ? cache : 0);
  }
  return map;
}

/**
 * 安装本地 APK
 *
 * 为什么用 child_process 而不是 adbkit 的 install：
 * - adbkit 3.x 的 install 走 bluebird Promise 链，在大 APK (>500MB) 上会 hang 住
 * - child_process 直接调 adb 命令行，等同终端执行，可靠且支持进度
 * - onProgress 回调：按"APK 字节数 + 推断速度"估算进度百分比（adb 本身只输出阶段性信息）
 */
export async function installApk(
  deviceId: string,
  apkPath: string,
  onProgress?: (info: { stage: string; percent: number; bytesPerSec?: number }) => void,
): Promise<void> {
  const adb = resolveAdbBinary() || 'adb';

  // 取 APK 大小用于计算百分比
  let totalBytes = 0;
  try {
    const stat = await import('fs').then((m) => m.statSync(apkPath));
    totalBytes = stat.size;
  } catch { /* ignore */ }

  return new Promise<void>((resolve, reject) => {
    // -r = reinstall; -d = allow downgrade; -g = grant all runtime permissions
    const args = ['-s', deviceId, 'install', '-r', '-d', apkPath];
    // eslint-disable-next-line no-console
    console.log('[install] spawn:', adb, args.join(' '));

    const child = spawn(adb, args, { windowsHide: true });
    let stdoutBuf = '';
    let stderrBuf = '';
    let stage = 'pushing';          // pushing / installing / done
    let percent = 0;
    const startAt = Date.now();

    // 假设 USB 2.0 典型速度 30MB/s；若有 stdout 进度会覆盖
    const ASSUMED_SPEED = 30 * 1024 * 1024;

    // 每 300ms 发一次进度（基于耗时 * 速度 ÷ 总字节数）
    const tick = setInterval(() => {
      if (stage === 'done') return;
      const elapsed = (Date.now() - startAt) / 1000;
      if (totalBytes > 0) {
        // pushing 阶段估算：最高到 92%（留 installing 阶段）
        const estimated = Math.min(92, (elapsed * ASSUMED_SPEED / totalBytes) * 100);
        if (estimated > percent) percent = estimated;
      }
      onProgress?.({ stage, percent, bytesPerSec: ASSUMED_SPEED });
    }, 300);

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdoutBuf += text;
      // 解析 adb 本身的输出切换阶段
      if (/Performing Streamed Install/i.test(text)) {
        stage = 'pushing';
      }
      // Android 新版本会输出 "Streaming: <sent> bytes / <total> bytes"
      const streamMatch = text.match(/Streaming:\s*(\d+)\s*bytes\s*\/\s*(\d+)\s*bytes/);
      if (streamMatch) {
        const sent = Number(streamMatch[1]);
        const tot = Number(streamMatch[2]);
        if (tot > 0) {
          percent = Math.min(92, (sent / tot) * 92);
        }
      }
      if (/Success|Failure/i.test(text)) {
        stage = 'installing';
        percent = 96;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });

    // 10 分钟超时
    const timeout = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      clearInterval(tick);
      reject(new Error('adb install timeout (10min)'));
    }, 10 * 60 * 1000);

    child.on('error', (err) => {
      clearTimeout(timeout);
      clearInterval(tick);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      clearInterval(tick);
      const output = (stdoutBuf + '\n' + stderrBuf).trim();
      // eslint-disable-next-line no-console
      console.log(`[install] done code=${code} output=${output.slice(0, 200)}`);
      if (code === 0 && /Success/i.test(output)) {
        stage = 'done';
        percent = 100;
        onProgress?.({ stage, percent });
        resolve();
      } else {
        reject(new Error(output || `adb install exited with code ${code}`));
      }
    });
  });
}

/** 卸载应用 */
export async function uninstallApp(deviceId: string, packageName: string): Promise<void> {
  const client = getAdbClient();
  await client.getDevice(deviceId).uninstall(packageName);
}

/**
 * 导出 APK 到本地目录（备份）
 * 步骤：pm path 取路径 → pull 到本地
 */
export async function exportApk(
  deviceId: string,
  packageName: string,
  outputDir: string
): Promise<string> {
  const client = getAdbClient();

  // 先确认 APK 路径
  const pathOut = await shellExec(deviceId, `pm path ${packageName}`);
  const apkPath = pathOut
    .split(/\r?\n/)
    .map((l) => l.replace(/^package:/, '').trim())
    .find((l) => l.endsWith('.apk'));

  if (!apkPath) {
    throw new Error(`未找到 ${packageName} 的 APK 路径`);
  }

  const localFile = join(outputDir, `${packageName}_${basename(apkPath)}`);
  const transfer = await client.getDevice(deviceId).pull(apkPath);

  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(localFile);
    transfer.on('end', () => resolve());
    transfer.on('error', reject);
    ws.on('error', reject);
    transfer.pipe(ws);
  });

  return localFile;
}
