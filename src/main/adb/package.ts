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
 * 读取设备上某个包的当前状态（用于 install 前后比对）
 *   installed：true/false
 *   versionCode：从 dumpsys 抓到的 versionCode（可能为 undefined）
 *   lastUpdateTime：dumpsys 里的最后更新时间字符串（用于覆盖安装前后比对）
 */
async function readPackageBaseline(
  deviceId: string,
  packageName: string,
): Promise<{ installed: boolean; versionCode?: number; lastUpdateTime?: string }> {
  // pm path 是最快的存在性判定
  const pmOut = await shellExec(deviceId, `pm path ${packageName}`, 8000);
  const installed = /^package:.+\.apk/m.test(pmOut);
  if (!installed) return { installed: false };

  // 取 versionCode + lastUpdateTime
  const dump = await shellExec(deviceId, `dumpsys package ${packageName}`, 10000);
  const vcStr = dump.match(/versionCode=(\d+)/)?.[1];
  const versionCode = vcStr ? Number(vcStr) : undefined;
  const lastUpdateTime = dump.match(/lastUpdateTime=([^\r\n]+)/)?.[1]?.trim();
  return { installed: true, versionCode, lastUpdateTime };
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
 *
 * 成功判定：
 *   主路径：adb 退出码 0 且 stdout 含 "Success"
 *   兜底：某些 adb 版本/时机下 stdout 没抓到内容（exit 0 但 output 为空）→
 *        装包前先抓基线（旧 versionCode + lastUpdateTime），装包后再抓一次，
 *        只有「versionCode 变了 / lastUpdateTime 更新了 / 之前根本不存在」才判定为成功；
 *        否则视为安装未生效（覆盖安装失败时不会误报）
 */
export async function installApk(
  deviceId: string,
  apkPath: string,
  onProgress?: (info: { stage: string; percent: number; bytesPerSec?: number }) => void,
  packageName?: string,         // 可选：用于 fallback 验证
  expectedVersionCode?: number, // 可选：APK 解析出的新版本号，用于精确比对
): Promise<void> {
  const adb = resolveAdbBinary() || 'adb';

  // 取 APK 大小用于计算百分比
  let totalBytes = 0;
  try {
    const stat = await import('fs').then((m) => m.statSync(apkPath));
    totalBytes = stat.size;
  } catch { /* ignore */ }

  // ---- 装包前基线：旧版本 versionCode + lastUpdateTime（仅在有 packageName 时收集）----
  type Baseline = {
    installed: boolean;
    versionCode?: number;
    lastUpdateTime?: string;
  };
  let baseline: Baseline = { installed: false };
  if (packageName) {
    baseline = await readPackageBaseline(deviceId, packageName);
    // eslint-disable-next-line no-console
    console.log(`[install] baseline ${packageName}:`, JSON.stringify(baseline));
  }

  // 主流程：spawn adb install
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    exited: boolean;
  }>((resolve, reject) => {
    // -r = reinstall; -d = allow downgrade
    const args = ['-s', deviceId, 'install', '-r', '-d', apkPath];
    // eslint-disable-next-line no-console
    console.log('[install] spawn:', adb, args.join(' '));

    const child = spawn(adb, args, {
      windowsHide: true,
      // 显式声明 stdio：忽略 stdin（避免 adb 等待输入），pipe stdout/stderr
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    let stage = 'pushing';
    let percent = 0;
    const startAt = Date.now();
    const ASSUMED_SPEED = 30 * 1024 * 1024;

    const tick = setInterval(() => {
      if (stage === 'done') return;
      const elapsed = (Date.now() - startAt) / 1000;
      if (totalBytes > 0) {
        const estimated = Math.min(92, (elapsed * ASSUMED_SPEED / totalBytes) * 100);
        if (estimated > percent) percent = estimated;
      }
      onProgress?.({ stage, percent, bytesPerSec: ASSUMED_SPEED });
    }, 300);

    // stdout 强制 utf8 编码
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');

    child.stdout!.on('data', (text: string) => {
      stdoutBuf += text;
      // eslint-disable-next-line no-console
      console.log(`[install] stdout: ${text.trimEnd()}`);
      if (/Performing Streamed Install/i.test(text)) stage = 'pushing';
      const m = text.match(/Streaming:\s*(\d+)\s*bytes\s*\/\s*(\d+)\s*bytes/);
      if (m) {
        const sent = Number(m[1]);
        const tot = Number(m[2]);
        if (tot > 0) percent = Math.min(92, (sent / tot) * 92);
      }
      if (/Success|Failure/i.test(text)) {
        stage = 'installing';
        percent = 96;
      }
    });
    child.stderr!.on('data', (text: string) => {
      stderrBuf += text;
      // eslint-disable-next-line no-console
      console.log(`[install] stderr: ${text.trimEnd()}`);
    });

    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;

    // 同时监听 exit + close（exit 早，close 是 stdio 完全关闭）
    child.on('exit', (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      // eslint-disable-next-line no-console
      console.log(`[install] exit code=${code} signal=${signal}`);
    });

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

    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      clearInterval(tick);
      // 优先取 close 的 code（因为 stdio 也已关闭、缓冲已 flush）
      const finalCode = code ?? exitCode;
      const finalSignal = signal ?? exitSignal;
      // eslint-disable-next-line no-console
      console.log(
        `[install] close code=${finalCode} signal=${finalSignal} stdoutLen=${stdoutBuf.length} stderrLen=${stderrBuf.length}`,
      );
      resolve({
        code: finalCode,
        signal: finalSignal,
        stdout: stdoutBuf,
        stderr: stderrBuf,
        exited,
      });
    });
  });

  const output = (result.stdout + '\n' + result.stderr).trim();

  // ---- 成功判定主路径 ----
  if (result.code === 0 && /Success/i.test(output)) {
    onProgress?.({ stage: 'done', percent: 100 });
    return;
  }

  // ---- 失败判定 / 兜底验证 ----

  // 明确 Failure：adb 已经报错了
  if (/Failure|FAILED/i.test(output)) {
    throw makeInstallError(adb, deviceId, apkPath, result.code, output, '安装被设备拒绝');
  }

  // exit 0 但没抓到 Success：可能是 adb 输出被吞了，做兜底验证
  if (result.code === 0 && packageName) {
    // eslint-disable-next-line no-console
    console.log(`[install] code=0 但 stdout 无 Success，开始兜底验证 ${packageName}`);
    try {
      const after = await readPackageBaseline(deviceId, packageName);
      // eslint-disable-next-line no-console
      console.log(`[install] after-install state ${packageName}:`, JSON.stringify(after));

      // 设备上根本没这个包（pm path 都查不到）→ 没装上
      if (!after.installed) {
        throw makeInstallError(
          adb, deviceId, apkPath, result.code, output,
          `adb exit=0 但设备上未找到 ${packageName}`,
        );
      }

      // 之前没装过，现在装上了 → 全新安装成功
      if (!baseline.installed) {
        // eslint-disable-next-line no-console
        console.log(`[install] 首次安装验证通过 ${packageName}`);
        onProgress?.({ stage: 'done', percent: 100 });
        return;
      }

      // 之前装过 → 必须 versionCode 不同 或 lastUpdateTime 变了，才算覆盖成功
      const vcChanged =
        after.versionCode != null &&
        baseline.versionCode != null &&
        after.versionCode !== baseline.versionCode;

      // 如果 APK 解析出了 expectedVersionCode，比对设备端实际拿到的（更精确）
      const matchesExpected =
        expectedVersionCode != null &&
        after.versionCode != null &&
        after.versionCode === expectedVersionCode;

      const utChanged =
        after.lastUpdateTime != null &&
        baseline.lastUpdateTime != null &&
        after.lastUpdateTime !== baseline.lastUpdateTime;

      if (vcChanged || matchesExpected || utChanged) {
        // eslint-disable-next-line no-console
        console.log(
          `[install] 覆盖安装验证通过：vcChanged=${vcChanged} matchesExpected=${matchesExpected} utChanged=${utChanged}`,
        );
        onProgress?.({ stage: 'done', percent: 100 });
        return;
      }

      // 各项指标都没变 → 安装根本没生效，机器上还是旧版
      throw makeInstallError(
        adb, deviceId, apkPath, result.code, output,
        `adb exit=0 但 ${packageName} 仍是旧版本 (versionCode=${after.versionCode ?? '?'})。
可能原因：签名不一致、降级被拒、空间不足、包名冲突。
请尝试先卸载旧版再安装。`,
      );
    } catch (e) {
      // 如果 throw 的就是我们造的 install error，直接往外抛
      if (e instanceof Error && e.message.startsWith('adb install 失败')) throw e;
      // 否则是 shellExec 等异常
      throw makeInstallError(
        adb, deviceId, apkPath, result.code, output,
        `验证安装结果失败：${(e as Error).message}`,
      );
    }
  }

  // 既没有 packageName 又没有明确成功标记 → 报错
  throw makeInstallError(adb, deviceId, apkPath, result.code, output);
}

function makeInstallError(
  adb: string,
  deviceId: string,
  apkPath: string,
  code: number | null,
  output: string,
  hint?: string,
): Error {
  const cmd = `${adb} -s ${deviceId} install -r -d ${apkPath}`;
  const parts = [
    `adb install 失败 (exit=${code})${hint ? '：' + hint : ''}`,
    `命令: ${cmd}`,
    output ? `输出:\n${output}` : '（adb 未输出任何内容）',
  ];
  return new Error(parts.join('\n'));
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
