/**
 * 应用元信息解析（真实名称 + 图标）
 *
 * 流程：
 * 1. adb shell pm path <pkg>  取 base.apk 路径
 * 2. adb pull <apk> -> 临时目录
 * 3. app-info-parser 解析 label（应用名）和 icon（图标 base64）
 * 4. 结果按 package + versionCode 缓存到本地磁盘，下次直接读缓存
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';
import { getAdbClient, AdbUtil } from './client';
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const AppInfoParser = require('app-info-parser/src/apk');

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

export interface AppMeta {
  packageName: string;
  label?: string;          // 真实应用名（多语言时优先中文）
  iconBase64?: string;     // data:image/png;base64,xxx 去前缀，仅 base64
  versionCode?: number;
  cachedAt: number;
}

const CACHE_DIR = join(app.getPath('userData'), 'app-meta-cache');
const TMP_DIR = join(app.getPath('temp'), 'apk-install-helper');

function ensureDirs() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
}

function cacheFileFor(packageName: string, versionCode?: number): string {
  const key = versionCode != null ? `${packageName}_${versionCode}` : packageName;
  return join(CACHE_DIR, `${key}.json`);
}

function readCache(packageName: string, versionCode?: number): AppMeta | null {
  const file = cacheFileFor(packageName, versionCode);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf8');
    return JSON.parse(raw) as AppMeta;
  } catch {
    return null;
  }
}

function writeCache(meta: AppMeta) {
  try {
    writeFileSync(cacheFileFor(meta.packageName, meta.versionCode), JSON.stringify(meta));
  } catch {
    /* ignore */
  }
}

/** 并发控制：防止同一时刻多次 pull 同一个包 */
const inflight = new Map<string, Promise<AppMeta>>();

/**
 * 解析 APK label，优先中文（zh/zh-CN），次选英文，最后取第一个
 * 支持以下形态：
 *  - string: "微信" 或 "resourceId:0x7f..."（未展开）
 *  - array<string>: ["微信", "WeChat", ...]
 *  - array<{locale,value}>: [{locale:'zh', value:'微信'}, ...]
 *
 * 中文识别难点：APK 的 label 数组里，日文/韩文/繁中/简中都混在一起。
 * 策略：
 *  1) 剔除含假名/谚文/其它非中英语种的候选
 *  2) 剩下的"中文候选"按"简体程度"打分，优先选简体：
 *       a. 含简体特征字（这些字繁体写法不同）→ 直接判定为简体
 *       b. 不含繁体特征字（这些字简体写法不同）→ 视为简体（兜住"简繁同形"的短名）
 *       c. 含繁体特征字 → 判为繁体，作为最后兜底
 *  3) 没有中文则退回纯英文
 *  4) 兜底取第一个非空字符串
 */
// 包含日文假名
const HAS_KANA = /[\u3040-\u309f\u30a0-\u30ff]/;
// 包含韩文谚文
const HAS_HANGUL = /[\uac00-\ud7af\u1100-\u11ff]/;
// 包含阿拉伯文 / 希伯来文 / 泰文 / 老挝 / 缅甸 / 高棉 / 天城文 / 藏文等非中英文
const HAS_NON_CHN = /[\u0590-\u07ff\u0e00-\u0fff\u1000-\u109f\u1780-\u17ff\u0900-\u097f]/;
// 含 CJK 表意文字（中/日/韩共用区）
const HAS_HAN = /[\u4e00-\u9fff]/;

/**
 * "简体特征字"：这些字在繁体里写法不同，出现即可视为简体。
 */
const SIMPLIFIED_CHARS = new Set(
  '们个为这来发会还说么时国对样过门见话长几从应电气车马号级简点单写实让该选边学专办东两书厂开关记师乐画问题业务请价风际报议结务转习极树员军连传医历顶仅页齐众优伦双图团尽队卫导寻当声异乱礼术况倾偿储兄党认讨让访讲许评读调谊谈谅谓询谋诺谢课设讯诉论训话语词试诗诱诲详听买卖鱼龙凤'.split('')
);
/**
 * "繁体特征字"：这些字在简体里写法不同，简体名里几乎不会出现。
 * 命中任意一个即视为繁体候选。
 */
const TRADITIONAL_CHARS = new Set(
  '們個為這來發會還說麼時國對樣過門見話長幾從應電氣車馬號級簡點單寫實讓該選邊學專辦東兩書廠開關記師樂畫問題業務請價風際報議結務轉習極樹員軍連傳醫歷頂僅頁齊眾優倫雙圖團盡隊衛導尋當聲異亂禮術況傾償儲黨認討讓訪講許評讀調誼談諒謂詢謀諾謝課設訊訴論訓話語詞試詩誘誨詳聽買賣魚龍鳳臺灣戰績檔資訊裡讚靜壓'.split('')
);
function hasSimplifiedChar(s: string): boolean {
  for (const c of s) if (SIMPLIFIED_CHARS.has(c)) return true;
  return false;
}
function hasTraditionalChar(s: string): boolean {
  for (const c of s) if (TRADITIONAL_CHARS.has(c)) return true;
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pickLabel(info: any): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: any = info?.application?.label ?? info?.label;

  const isUnresolved = (v: unknown) =>
    typeof v === 'string' && v.startsWith('resourceId:');

  const toStringVal = (v: unknown): string | undefined => {
    if (typeof v === 'string' && !isUnresolved(v) && v.length > 0) return v;
    if (v && typeof v === 'object') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s = (v as any).value;
      if (typeof s === 'string' && !isUnresolved(s) && s.length > 0) return s;
    }
    return undefined;
  };

  // 归一化成字符串数组
  let candidates: string[] = [];
  if (typeof raw === 'string') {
    const s = toStringVal(raw);
    if (s) candidates = [s];
  } else if (Array.isArray(raw)) {
    candidates = raw.map(toStringVal).filter((v): v is string => !!v);
  }
  if (candidates.length === 0) return undefined;

  const isPureCJK = (s: string) =>
    HAS_HAN.test(s) && !HAS_KANA.test(s) && !HAS_HANGUL.test(s) && !HAS_NON_CHN.test(s);

  const chineseCandidates = candidates.filter(isPureCJK);

  // 1) 含简体特征字符 → 简体（最稳）
  const zhCNStrong = chineseCandidates.find(hasSimplifiedChar);
  if (zhCNStrong) return zhCNStrong;

  // 2) 不含繁体特征字符 → 视作简体（兜住"简繁同形"的短名，比如 "微信"/"百度"/"抖音"）
  const zhCNFallback = chineseCandidates.find((s) => !hasTraditionalChar(s));
  if (zhCNFallback) return zhCNFallback;

  // 3) 全是繁体 → 拿第一个
  if (chineseCandidates[0]) return chineseCandidates[0];

  // 4) 纯英文
  const en = candidates.find((s) => /^[\x20-\x7e]+$/.test(s));
  if (en) return en;

  // 5) 兜底
  return candidates[0];
}

/** 调试开关：设为 true 可以无视磁盘缓存，强制每次都重新解析 */
const FORCE_REPARSE = false;
/** 调试：打印前几次 label 结构（便于排查） */
let debugCount = 0;
const DEBUG_MAX = 5;

/**
 * 获取单个应用的元信息（label + icon）
 * 会先查缓存；未命中则 pull base.apk 解析
 */
export async function getAppMeta(
  packageName: string,
  deviceId: string,
  versionCode?: number
): Promise<AppMeta> {
  ensureDirs();

  // 缓存命中（FORCE_REPARSE=true 时跳过）
  if (!FORCE_REPARSE) {
    const cached = readCache(packageName, versionCode);
    if (cached) return cached;
  }

  // 合并同一 key 的并发请求
  const key = `${deviceId}:${packageName}:${versionCode ?? ''}`;
  const running = inflight.get(key);
  if (running) return running;

  const job = (async (): Promise<AppMeta> => {
    const client = getAdbClient();
    const device = client.getDevice(deviceId);

    // 1. pm path -> apkPath
    let apkPathOnDevice: string | undefined;
    try {
      const stream = await withTimeout(
        device.shell(`pm path ${packageName}`),
        10000,
        `pm path ${packageName}`,
      );
      const buf: Buffer = await withTimeout(
        AdbUtil.readAll(stream),
        10000,
        `readAll pm path ${packageName}`,
      );
      const lines = buf.toString('utf8').split(/\r?\n/);
      apkPathOnDevice = lines
        .map((l) => l.replace(/^package:/, '').trim())
        .find((l) => l.endsWith('base.apk')) ||
        lines
          .map((l) => l.replace(/^package:/, '').trim())
          .find((l) => l.endsWith('.apk'));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[meta] ${packageName} pm path failed:`, (e as Error).message);
    }

    if (!apkPathOnDevice) {
      // eslint-disable-next-line no-console
      console.warn(`[meta] ${packageName} no apk path found`);
      const fallback: AppMeta = { packageName, versionCode, cachedAt: Date.now() };
      writeCache(fallback);
      return fallback;
    }

    // 2. pull 到临时文件（60 秒超时，大 APK 可能较慢）
    const localApk = join(TMP_DIR, `${packageName}_${Date.now()}.apk`);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const transfer: any = await withTimeout(
        device.pull(apkPathOnDevice),
        60000,
        `pull ${apkPathOnDevice}`,
      );
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          const ws = createWriteStream(localApk);
          transfer.on('end', () => resolve());
          transfer.on('error', reject);
          ws.on('error', reject);
          transfer.pipe(ws);
        }),
        120000,
        `write ${packageName}`,
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[meta] ${packageName} pull failed:`, (e as Error).message);
      try { unlinkSync(localApk); } catch { /* noop */ }
      const fallback: AppMeta = { packageName, versionCode, cachedAt: Date.now() };
      writeCache(fallback);
      return fallback;
    }

    // 3. 解析
    let label: string | undefined;
    let iconBase64: string | undefined;
    try {
      const parser = new AppInfoParser(localApk);
      const info = await parser.parse();
      label = pickLabel(info);
      // icon 可能是 data URI，也可能是原始 base64
      const rawIcon: string | undefined = info?.icon;
      if (typeof rawIcon === 'string') {
        iconBase64 = rawIcon.replace(/^data:image\/\w+;base64,/, '');
      }
      // 调试：打印前几次的 label 结构，便于排查解析问题
      if (debugCount < DEBUG_MAX) {
        debugCount++;
        // eslint-disable-next-line no-console
        console.log(`[meta] ${packageName} label=`,
          JSON.stringify(info?.application?.label),
          'picked=', label);
      }
    } catch (e) {
      // overlay / 非标准 APK 解析失败是常见现象，降低噪声
      const msg = (e as Error).message || '';
      const isExpectedFailure = /overlay|rro|central directory|arsc/i.test(
        `${packageName} ${msg}`,
      );
      if (!isExpectedFailure) {
        // eslint-disable-next-line no-console
        console.warn(`[meta] parse failed for ${packageName}:`, msg);
      }
    } finally {
      // 清理临时 APK
      try { unlinkSync(localApk); } catch { /* noop */ }
    }

    const meta: AppMeta = {
      packageName,
      label,
      iconBase64,
      versionCode,
      cachedAt: Date.now(),
    };
    writeCache(meta);
    return meta;
  })();

  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}

/** 清除所有缓存（调试 / 修复历史错乱的 label 时使用） */
export function clearMetaCache() {
  ensureDirs();
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const fs = require('fs');
    const files: string[] = fs.readdirSync(CACHE_DIR);
    for (const f of files) {
      try { fs.unlinkSync(join(CACHE_DIR, f)); } catch { /* ignore */ }
    }
    // eslint-disable-next-line no-console
    console.log(`[meta] cleared ${files.length} cache file(s)`);
  } catch { /* ignore */ }
}

/**
 * 从本地 APK 文件（PC 侧）直接解析 label/icon，并写入 meta 缓存
 * 用于"刚刚装完某个 APK"的场景 —— 避免再从设备 pull 回来浪费时间
 *
 * @returns 解析出来的 packageName（便于调用方匹配到应用列表的行）
 */
export async function precacheMetaFromLocalApk(
  localApkPath: string,
): Promise<{ packageName?: string; label?: string; iconBase64?: string; versionCode?: number }> {
  ensureDirs();
  try {
    const parser = new AppInfoParser(localApkPath);
    const info = await parser.parse();

    const packageName: string | undefined = info?.package ?? info?.packageName;
    const versionCodeRaw = info?.versionCode ?? info?.manifest?.versionCode;
    const versionCode = versionCodeRaw != null ? Number(versionCodeRaw) : undefined;
    const label = pickLabel(info);
    let iconBase64: string | undefined;
    const rawIcon: string | undefined = info?.icon;
    if (typeof rawIcon === 'string') {
      iconBase64 = rawIcon.replace(/^data:image\/\w+;base64,/, '');
    }

    if (packageName) {
      const meta: AppMeta = {
        packageName,
        label,
        iconBase64,
        versionCode,
        cachedAt: Date.now(),
      };
      // 写两份：带 versionCode 的（命中精确版本）+ 不带的（fallback）
      writeCache(meta);
      if (versionCode != null) {
        const metaNoVer: AppMeta = { ...meta, versionCode: undefined };
        writeCache(metaNoVer);
      }
      // eslint-disable-next-line no-console
      console.log(`[meta] precache from local apk: ${packageName} label="${label ?? ''}" vc=${versionCode ?? ''}`);
    }

    return { packageName, label, iconBase64, versionCode };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[meta] precacheMetaFromLocalApk failed for ${localApkPath}:`, (e as Error).message);
    return {};
  }
}

/**
 * 删除指定包的 meta 缓存（任意 versionCode）
 * 覆盖安装后新旧 versionCode 不同，旧缓存可能残留旧图标，清掉更保险
 * 但当前 cacheFileFor 以 pkg + versionCode 为 key，列出所有需要 readdir
 */
export function clearMetaCacheForPackage(packageName: string) {
  ensureDirs();
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const fs = require('fs');
    const files: string[] = fs.readdirSync(CACHE_DIR);
    for (const f of files) {
      if (f === `${packageName}.json` || f.startsWith(`${packageName}_`)) {
        try { fs.unlinkSync(join(CACHE_DIR, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

/**
 * 批量读取多个包的 meta（仅返回缓存命中的）
 * 一次 IPC 解决多个 readFileSync，避免跨进程往返开销
 */
export function getAppMetaBatch(
  items: { packageName: string; versionCode?: number }[],
): AppMeta[] {
  ensureDirs();
  const result: AppMeta[] = [];
  for (const it of items) {
    const cached = readCache(it.packageName, it.versionCode);
    if (cached) result.push(cached);
  }
  return result;
}
