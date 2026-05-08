/**
 * 应用使用频率统计：
 *  - 设备端：adb shell dumpsys usagestats 拉取 appLaunchCount
 *  - PC 端：本地 JSON 文件累加用户在本应用内对每个 pkg 的操作次数
 *
 * 综合分公式：
 *   score = deviceUseCount * 0.6 + pcInteractCount * 8 * 0.4
 * （PC 单次交互更稀缺，乘 8 拉权重）
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { app } from 'electron';
import { getAdbClient, AdbUtil } from './client';

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

async function shellExec(deviceId: string, cmd: string, timeoutMs = 25000): Promise<string> {
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
    // eslint-disable-next-line no-console
    console.warn(`[usage] shell "${cmd.slice(0, 60)}" failed:`, (e as Error).message);
    return '';
  }
}

/**
 * 解析 dumpsys usagestats 输出。
 *
 * 兼容多种 Android 版本格式：
 *   - "package=com.xxx ... appLaunchCount=12"
 *   - "Package: com.xxx, totalTimeUsed=..., totalLaunchCount=..."
 *
 * 同一 pkg 多段时取最大值。
 */
function parseUsageStats(output: string): Record<string, number> {
  const map: Record<string, number> = {};
  if (!output) return map;

  // 模式 1：同一行内含 package= 和 appLaunchCount=
  const re1 = /package=([\w.]+)[^\n]*?(?:appLaunchCount|totalLaunchCount)=(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re1.exec(output)) !== null) {
    const pkg = m[1];
    const cnt = Number(m[2]);
    if (!Number.isFinite(cnt)) continue;
    if (cnt > (map[pkg] ?? 0)) map[pkg] = cnt;
  }

  // 模式 2：跨行的 Package: + 后续 appLaunchCount
  const re2 = /Package:\s*([\w.]+)([\s\S]{0,400}?)(?:appLaunchCount|totalLaunchCount)=(\d+)/g;
  while ((m = re2.exec(output)) !== null) {
    const pkg = m[1];
    const cnt = Number(m[3]);
    if (!Number.isFinite(cnt)) continue;
    if (cnt > (map[pkg] ?? 0)) map[pkg] = cnt;
  }
  return map;
}

/** 拉设备端使用次数：pkg → 启动次数（取所有时间区间的最大值） */
export async function getDeviceAppUsage(deviceId: string): Promise<Record<string, number>> {
  const out = await shellExec(deviceId, 'dumpsys usagestats', 30000);
  return parseUsageStats(out);
}

// ============== PC 端交互统计（本地 JSON） ==============

export type InteractKind = 'install' | 'uninstall' | 'export' | 'view';

interface InteractRecord {
  count: number;
  lastAt: number; // ms
}
interface InteractStore {
  // pkg → kind → record
  [pkg: string]: Partial<Record<InteractKind, InteractRecord>>;
}

const INTERACT_FILE = join(app.getPath('userData'), 'interact-stats.json');
let cache: InteractStore | null = null;

function load(): InteractStore {
  if (cache) return cache;
  try {
    if (existsSync(INTERACT_FILE)) {
      cache = JSON.parse(readFileSync(INTERACT_FILE, 'utf8')) as InteractStore;
      return cache;
    }
  } catch {/* ignore */}
  cache = {};
  return cache;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveDebounced() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      mkdirSync(dirname(INTERACT_FILE), { recursive: true });
      writeFileSync(INTERACT_FILE, JSON.stringify(cache));
    } catch {/* ignore */}
  }, 500);
}

/** 记录一次 PC 端交互 */
export function recordInteract(packageName: string, kind: InteractKind): void {
  if (!packageName) return;
  const store = load();
  const pkg = (store[packageName] ??= {});
  const rec = (pkg[kind] ??= { count: 0, lastAt: 0 });
  rec.count += 1;
  rec.lastAt = Date.now();
  saveDebounced();
}

/** 计算每个 pkg 的 PC 交互总分（所有 kind 求和） */
export function getPcInteractScores(): Record<string, number> {
  const store = load();
  const map: Record<string, number> = {};
  for (const [pkg, kinds] of Object.entries(store)) {
    let sum = 0;
    for (const k of Object.values(kinds ?? {})) {
      if (k) sum += k.count;
    }
    if (sum > 0) map[pkg] = sum;
  }
  return map;
}

/**
 * 获取每个 pkg 的最近一次"PC 端安装"时间戳（ms）
 * 用于把新装的 APK 置顶
 */
export function getPcInstallTimes(): Record<string, number> {
  const store = load();
  const map: Record<string, number> = {};
  for (const [pkg, kinds] of Object.entries(store)) {
    const t = kinds?.install?.lastAt;
    if (t && t > 0) map[pkg] = t;
  }
  return map;
}
