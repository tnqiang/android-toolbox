/**
 * 设备相关：列表、详情、插拔事件追踪
 *
 * adbkit 3.x 改动：所有设备级操作走 client.getDevice(serial) 返回的 DeviceClient
 */
import { getAdbClient, AdbUtil } from './client';
import type { DeviceInfo } from '../../shared/types';

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

/** 解析 `adb shell getprop` 输出（[key]: [value] 格式） */
function parseGetProp(output: string): Record<string, string> {
  const map: Record<string, string> = {};
  const re = /\[([^\]]+)\]:\s*\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    map[m[1]] = m[2];
  }
  return map;
}

async function readDeviceProps(deviceId: string): Promise<Record<string, string>> {
  const client = getAdbClient();
  try {
    const stream = await withTimeout(
      client.getDevice(deviceId).shell('getprop'),
      8000,
      'shell getprop',
    );
    const buf: Buffer = await withTimeout(
      AdbUtil.readAll(stream),
      8000,
      'readAll getprop',
    );
    return parseGetProp(buf.toString('utf8'));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[device] getprop failed:', (e as Error).message);
    return {};
  }
}

/** 列出当前所有设备（含基础信息） */
export async function listDevices(): Promise<DeviceInfo[]> {
  const client = getAdbClient();
  const devices = await client.listDevices();
  const result: DeviceInfo[] = [];
  for (const d of devices) {
    if (d.type !== 'device') {
      result.push({ id: d.id, state: d.type as DeviceInfo['state'] });
      continue;
    }
    const props = await readDeviceProps(d.id);
    result.push({
      id: d.id,
      state: 'device',
      brand: props['ro.product.brand'],
      model: props['ro.product.model'],
      product: props['ro.product.name'],
      androidVersion: props['ro.build.version.release'],
      sdkVersion: props['ro.build.version.sdk'],
      serialno: props['ro.serialno'] || d.id,
    });
  }
  return result;
}

/** 启动设备插拔追踪，返回 dispose 函数 */
export async function trackDevices(
  onChange: (devices: DeviceInfo[]) => void
): Promise<() => void> {
  const client = getAdbClient();
  const tracker = await client.trackDevices();

  const refresh = async () => {
    try {
      const list = await listDevices();
      onChange(list);
    } catch {
      /* 一过性错误忽略 */
    }
  };

  tracker.on('add', refresh);
  tracker.on('remove', refresh);
  tracker.on('change', refresh);
  tracker.on('error', () => { /* swallow */ });

  // 首次推送
  void refresh();

  return () => {
    try { tracker.end(); } catch { /* noop */ }
  };
}
