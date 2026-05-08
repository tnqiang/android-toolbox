/**
 * 设备详细信息：硬件/系统/电池/存储
 */
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

async function shellExec(deviceId: string, cmd: string, timeoutMs = 8000): Promise<string> {
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
    console.warn(`[deviceInfo] shell "${cmd.slice(0, 60)}" failed:`, (e as Error).message);
    return '';
  }
}

export interface BatteryInfo {
  level?: number;           // 电量百分比
  status?: string;          // 充电状态 Charging/Discharging
  health?: string;          // 健康状态
  temperature?: number;     // 温度（摄氏度）
  voltage?: number;         // 电压 (mV)
  technology?: string;      // 电池类型 (Li-ion)
  isCharging?: boolean;
}

export interface StorageInfo {
  totalBytes?: number;
  usedBytes?: number;
  availableBytes?: number;
}

export interface MemoryInfo {
  totalBytes?: number;
  availableBytes?: number;
  usedBytes?: number;
}

export interface DeviceDetailInfo {
  deviceId: string;
  // 基础
  brand?: string;
  manufacturer?: string;
  model?: string;
  product?: string;           // 内部代号
  serialno?: string;
  // 系统
  androidVersion?: string;
  sdkVersion?: string;
  buildNumber?: string;
  buildDate?: string;
  securityPatch?: string;
  // CPU
  cpuAbi?: string;
  cpuHardware?: string;
  socManufacturer?: string;   // 例：Qualcomm / MediaTek / 海思
  socModel?: string;          // 例：SM8650 / Dimensity 9300
  // 屏幕
  screenResolution?: string;  // "1080x2400"
  screenDensity?: string;     // DPI
  // 网络
  imei?: string;
  macAddress?: string;
  // 其他
  kernelVersion?: string;
  bootloader?: string;
  rootStatus?: 'rooted' | 'not-rooted' | 'unknown';
  region?: string;
  // 电池与存储
  battery?: BatteryInfo;
  storage?: StorageInfo;
  memory?: MemoryInfo;
}

function parseGetProp(output: string): Record<string, string> {
  const map: Record<string, string> = {};
  const re = /\[([^\]]+)\]:\s*\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    map[m[1]] = m[2];
  }
  return map;
}

function parseBattery(output: string): BatteryInfo {
  const get = (key: string) => {
    const m = output.match(new RegExp(`${key}:\\s*(.+)`));
    return m?.[1]?.trim();
  };
  const statusCode = get('status');
  const healthCode = get('health');
  const statusMap: Record<string, string> = {
    '1': '未知', '2': '充电中', '3': '未充电', '4': '未充电', '5': '已充满',
  };
  const healthMap: Record<string, string> = {
    '1': '未知', '2': '良好', '3': '过热', '4': '损坏', '5': '过压', '6': '失败', '7': '过冷',
  };
  const level = get('level');
  const temp = get('temperature');
  const volt = get('voltage');
  const acPowered = get('AC powered');
  const usbPowered = get('USB powered');
  return {
    level: level ? Number(level) : undefined,
    status: statusCode ? (statusMap[statusCode] ?? statusCode) : undefined,
    health: healthCode ? (healthMap[healthCode] ?? healthCode) : undefined,
    temperature: temp ? Number(temp) / 10 : undefined,
    voltage: volt ? Number(volt) : undefined,
    technology: get('technology'),
    isCharging: acPowered === 'true' || usbPowered === 'true',
  };
}

function parseStorage(output: string): StorageInfo {
  // df 输出第二行：/dev/block/xxx  total  used  avail  use%  /data
  const lines = output.trim().split(/\r?\n/);
  for (const line of lines) {
    if (!/\/data\b/.test(line) && !/\s\/$/.test(line)) continue;
    const parts = line.split(/\s+/);
    // 兼容 df -k 和 df -h：-k 返回 KB，-h 返回 "12G" 字样
    if (parts.length >= 4) {
      const totalStr = parts[1];
      const usedStr = parts[2];
      const availStr = parts[3];
      const toBytes = (s: string): number | undefined => {
        if (!s) return undefined;
        const n = parseFloat(s);
        if (Number.isNaN(n)) return undefined;
        if (/G$/i.test(s)) return Math.round(n * 1024 * 1024 * 1024);
        if (/M$/i.test(s)) return Math.round(n * 1024 * 1024);
        if (/K$/i.test(s)) return Math.round(n * 1024);
        // 默认 KB（df 无 -h）
        return Math.round(n * 1024);
      };
      return {
        totalBytes: toBytes(totalStr),
        usedBytes: toBytes(usedStr),
        availableBytes: toBytes(availStr),
      };
    }
  }
  return {};
}

function parseResolution(wmOutput: string): string | undefined {
  // "Physical size: 1080x2400"
  const m = wmOutput.match(/Physical size:\s*(\d+x\d+)/);
  return m?.[1];
}

function parseDpi(wmOutput: string): string | undefined {
  const m = wmOutput.match(/Physical density:\s*(\d+)/);
  return m?.[1];
}

/** 解析 /proc/meminfo（kB 单位） */
function parseMemInfo(output: string): MemoryInfo {
  const get = (key: string) => {
    const m = output.match(new RegExp(`^${key}:\\s*(\\d+)\\s*kB`, 'm'));
    return m ? Number(m[1]) * 1024 : undefined;
  };
  const totalBytes = get('MemTotal');
  const availableBytes = get('MemAvailable') ?? get('MemFree');
  const usedBytes =
    totalBytes != null && availableBytes != null
      ? totalBytes - availableBytes
      : undefined;
  return { totalBytes, availableBytes, usedBytes };
}

export async function getDeviceDetailInfo(deviceId: string): Promise<DeviceDetailInfo> {
  // 并行发起多个 shell
  const [
    propOut,
    batteryOut,
    storageOut,
    sizeOut,
    densityOut,
    kernelOut,
    suOut,
    cpuinfoOut,
    meminfoOut,
  ] = await Promise.all([
    shellExec(deviceId, 'getprop'),
    shellExec(deviceId, 'dumpsys battery'),
    shellExec(deviceId, 'df -h /data'),
    shellExec(deviceId, 'wm size'),
    shellExec(deviceId, 'wm density'),
    shellExec(deviceId, 'uname -a'),
    shellExec(deviceId, 'which su'),
    shellExec(deviceId, 'cat /proc/cpuinfo'),
    shellExec(deviceId, 'cat /proc/meminfo'),
  ]);

  const props = parseGetProp(propOut);

  // SoC 信息：优先 Android 12+ 的标准属性，其次 board.platform，最后 /proc/cpuinfo Hardware 行
  const cpuinfoHardware = cpuinfoOut.match(/^Hardware\s*:\s*(.+)$/m)?.[1]?.trim();
  const socManufacturer =
    props['ro.soc.manufacturer'] ||
    props['ro.boot.hardware.platform'] ||
    undefined;
  const socModel =
    props['ro.soc.model'] ||
    props['ro.board.platform'] ||
    cpuinfoHardware ||
    undefined;

  const info: DeviceDetailInfo = {
    deviceId,
    brand: props['ro.product.brand'],
    manufacturer: props['ro.product.manufacturer'],
    model: props['ro.product.model'],
    product: props['ro.product.name'],
    serialno: props['ro.serialno'] || deviceId,

    androidVersion: props['ro.build.version.release'],
    sdkVersion: props['ro.build.version.sdk'],
    buildNumber: props['ro.build.display.id'] || props['ro.build.id'],
    buildDate: props['ro.build.date'],
    securityPatch: props['ro.build.version.security_patch'],

    cpuAbi: props['ro.product.cpu.abi'],
    cpuHardware: props['ro.hardware'],
    socManufacturer,
    socModel,

    screenResolution: parseResolution(sizeOut),
    screenDensity: parseDpi(densityOut),

    macAddress: props['ro.boot.wifimacaddress'],
    kernelVersion: kernelOut.trim() || undefined,
    bootloader: props['ro.bootloader'],
    rootStatus: suOut.trim() ? 'rooted' : 'not-rooted',
    region: props['ro.csc.country_code'] || props['ro.product.locale'],

    battery: parseBattery(batteryOut),
    storage: parseStorage(storageOut),
    memory: parseMemInfo(meminfoOut),
  };

  return info;
}

/** 重启设备 */
export async function rebootDevice(deviceId: string): Promise<void> {
  await shellExec(deviceId, 'reboot', 5000);
}

/** 关机 */
export async function powerOffDevice(deviceId: string): Promise<void> {
  await shellExec(deviceId, 'reboot -p', 5000);
}

/**
 * 截屏：返回 base64 编码的 PNG（不含 data: 前缀）
 * 优先用 adbkit 的 device.screencap()（走 adb 内部协议，比 shell screencap 快）
 * 失败 fallback 到 `exec-out screencap -p` 的 stdout
 */
export async function takeScreenshot(deviceId: string): Promise<string> {
  const client = getAdbClient();
  const device = client.getDevice(deviceId);

  // 方案 A：device.screencap()
  try {
    const stream = await withTimeout(device.screencap(), 12000, 'screencap');
    const buf: Buffer = await withTimeout(AdbUtil.readAll(stream), 12000, 'screencap readAll');
    return buf.toString('base64');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[screenshot] screencap() failed, fallback to shell:', (e as Error).message);
  }

  // 方案 B：shell exec-out screencap -p（更兼容，但需要二进制流）
  try {
    const stream = await withTimeout(
      device.shell('screencap -p'),
      12000,
      'shell screencap -p',
    );
    const buf: Buffer = await withTimeout(AdbUtil.readAll(stream), 12000, 'screencap shell readAll');
    return buf.toString('base64');
  } catch (e) {
    throw new Error(`截屏失败：${(e as Error).message}`);
  }
}
