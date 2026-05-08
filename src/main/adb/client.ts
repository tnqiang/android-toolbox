/**
 * adbkit 客户端单例
 * 内置 adb 二进制查找：dev 用系统 PATH 中的 adb，生产用 resources/adb 下打包的 adb
 *
 * 注意：@devicefarmer/adbkit 的入口 dist/index.js 用了双层 __importDefault
 * 在 CJS 下会让 default 多包一层，所以这里直接从 dist/src/adb 引入。
 */
import { app } from 'electron';
import { join } from 'path';
import { existsSync } from 'fs';

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const AdbModule = require('@devicefarmer/adbkit/dist/src/adb');
// AdbModule 形如 { default: Adb, __esModule: true }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Adb: any = AdbModule.default ?? AdbModule;

export type AdbClient = ReturnType<typeof Adb.createClient>;

let cachedClient: AdbClient | null = null;

export function resolveAdbBinary(): string | undefined {
  // 生产环境：electron-builder 通过 extraResources 把 adb 放到 process.resourcesPath/adb
  if (app.isPackaged) {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const candidate = join(process.resourcesPath, 'adb', `adb${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  // 开发环境：尝试项目 resources 目录
  const platformDir =
    process.platform === 'win32' ? 'windows' :
    process.platform === 'darwin' ? 'macos' : 'linux';
  const ext = process.platform === 'win32' ? '.exe' : '';
  const devCandidate = join(process.cwd(), 'resources', 'adb', platformDir, `adb${ext}`);
  if (existsSync(devCandidate)) return devCandidate;

  // 最后回退：依赖系统 PATH
  return undefined;
}

export function getAdbClient(): AdbClient {
  if (cachedClient) return cachedClient;
  if (typeof Adb?.createClient !== 'function') {
    // eslint-disable-next-line no-console
    console.error('[adb] Adb 模块结构异常:', Object.keys(AdbModule), Object.keys(Adb ?? {}));
    throw new Error('adbkit 加载失败：Adb.createClient 不是函数');
  }
  const bin = resolveAdbBinary();
  cachedClient = Adb.createClient(bin ? { bin } : {});
  return cachedClient!;
}

export function resetAdbClient() {
  cachedClient = null;
}

/** 暴露给其他模块使用的 util（util.readAll 等） */
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const UtilModule = require('@devicefarmer/adbkit/dist/src/adb/util');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const AdbUtil: any = UtilModule.default ?? UtilModule;
