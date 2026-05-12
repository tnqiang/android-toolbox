/**
 * IPC 处理器注册：把 adb 服务暴露给渲染进程
 */
import { ipcMain, BrowserWindow } from 'electron';
import { IpcChannels } from '../../shared/types';
import type { AppCategory, IpcResult } from '../../shared/types';
import { listDevices, trackDevices } from './device';
import { listApps, getAppDetail, getAppDetailBatch, getAllAppDataSizes, installApk, uninstallApp, exportApk, clearDetailCacheForPackage } from './package';
import { getAppMeta, getAppMetaBatch, precacheMetaFromLocalApk } from './meta';
import { getDeviceDetailInfo, rebootDevice, powerOffDevice, takeScreenshot } from './deviceInfo';
import { getDeviceAppUsage, getPcInteractScores, getPcInstallTimes, recordInteract, type InteractKind } from './usage';
import {
  listDir, listDirStreaming, pullFile, pushFile, mkdirRemote, removeRemote, renameRemote,
  probeRemote, joinRemote,
} from './fs';
import { basename, join as joinPath } from 'path';
import { existsSync, mkdirSync, statSync, readdirSync } from 'fs';

let disposeTracker: (() => void) | null = null;

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}
function fail(error: unknown): IpcResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

export function registerAdbHandlers(getWindow: () => BrowserWindow | null) {
  // ---- 设备 ----
  ipcMain.handle(IpcChannels.DEVICE_LIST, async () => {
    try { return ok(await listDevices()); } catch (e) { return fail(e); }
  });

  ipcMain.handle(IpcChannels.DEVICE_INFO_DETAIL, async (_e, deviceId: string) => {
    try { return ok(await getDeviceDetailInfo(deviceId)); } catch (e) { return fail(e); }
  });

  ipcMain.handle(IpcChannels.DEVICE_REBOOT, async (_e, deviceId: string) => {
    try { await rebootDevice(deviceId); return ok(true); } catch (e) { return fail(e); }
  });

  ipcMain.handle(IpcChannels.DEVICE_POWER_OFF, async (_e, deviceId: string) => {
    try { await powerOffDevice(deviceId); return ok(true); } catch (e) { return fail(e); }
  });

  ipcMain.handle(IpcChannels.DEVICE_SCREENSHOT, async (_e, deviceId: string) => {
    try { return ok(await takeScreenshot(deviceId)); } catch (e) { return fail(e); }
  });

  // 设备插拔追踪 - 渲染进程主动启动，主进程推送
  ipcMain.handle(IpcChannels.DEVICE_TRACK, async () => {
    if (disposeTracker) return ok(true); // 已启动
    try {
      disposeTracker = await trackDevices((devices) => {
        const win = getWindow();
        win?.webContents.send(IpcChannels.DEVICE_TRACK, devices);
      });
      return ok(true);
    } catch (e) {
      return fail(e);
    }
  });

  // ---- 应用 ----
  ipcMain.handle(
    IpcChannels.APP_LIST,
    async (_e, deviceId: string, category: AppCategory = 'user') => {
      try { return ok(await listApps(deviceId, category)); } catch (e) { return fail(e); }
    }
  );

  ipcMain.handle(
    IpcChannels.APP_DATA_SIZES,
    async (_e, deviceId: string) => {
      try { return ok(await getAllAppDataSizes(deviceId)); } catch (e) { return fail(e); }
    }
  );

  ipcMain.handle(
    IpcChannels.APP_DEVICE_USAGE,
    async (_e, deviceId: string) => {
      try { return ok(await getDeviceAppUsage(deviceId)); } catch (e) { return fail(e); }
    }
  );

  ipcMain.handle(IpcChannels.APP_PC_INTERACT_GET, async () => {
    try { return ok(getPcInteractScores()); } catch (e) { return fail(e); }
  });

  ipcMain.handle(IpcChannels.APP_PC_INSTALL_TIMES, async () => {
    try { return ok(getPcInstallTimes()); } catch (e) { return fail(e); }
  });

  ipcMain.handle(
    IpcChannels.APP_PC_INTERACT_RECORD,
    async (_e, packageName: string, kind: InteractKind) => {
      try { recordInteract(packageName, kind); return ok(true); } catch (e) { return fail(e); }
    }
  );

  ipcMain.handle(
    IpcChannels.APP_INSTALL,
    async (e, deviceId: string, apkPaths: string[]) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      const results: { apk: string; ok: boolean; error?: string; packageName?: string }[] = [];
      for (const apk of apkPaths) {
        // —— 安装前：本地解析 APK 预写 meta 缓存（label/icon/packageName/versionCode）——
        // 这样装完后列表刷新时就能直接命中缓存，不需要再 adb pull 回来
        let precachedPkg: string | undefined;
        let precachedVc: number | undefined;
        try {
          const pre = await precacheMetaFromLocalApk(apk);
          precachedPkg = pre.packageName;
          precachedVc = pre.versionCode;
        } catch { /* ignore */ }

        win?.webContents.send(IpcChannels.APP_INSTALL_PROGRESS, {
          apk, status: 'installing', percent: 0, stage: 'starting',
          packageName: precachedPkg,
        });
        try {
          await installApk(deviceId, apk, (info) => {
            win?.webContents.send(IpcChannels.APP_INSTALL_PROGRESS, {
              apk,
              status: 'installing',
              percent: Math.round(info.percent),
              stage: info.stage,
              packageName: precachedPkg,
            });
          }, precachedPkg, precachedVc);
          results.push({ apk, ok: true, packageName: precachedPkg });
          // —— 安装后：apkPath 已改变，旧 detail 缓存失效，清掉 ——
          if (precachedPkg) clearDetailCacheForPackage(precachedPkg);
          // —— 记录一次 PC 端"install"交互，用于"按安装顺序置顶" ——
          if (precachedPkg) recordInteract(precachedPkg, 'install');
          win?.webContents.send(IpcChannels.APP_INSTALL_PROGRESS, {
            apk, status: 'success', percent: 100, stage: 'done',
            packageName: precachedPkg,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ apk, ok: false, error: msg, packageName: precachedPkg });
          win?.webContents.send(IpcChannels.APP_INSTALL_PROGRESS, {
            apk, status: 'failed', error: msg, percent: 0, stage: 'failed',
            packageName: precachedPkg,
          });
        }
      }
      return ok(results);
    }
  );

  ipcMain.handle(
    IpcChannels.APP_UNINSTALL,
    async (_e, deviceId: string, packageName: string) => {
      try {
        await uninstallApp(deviceId, packageName);
        recordInteract(packageName, 'uninstall');
        return ok(true);
      } catch (e) { return fail(e); }
    }
  );

  ipcMain.handle(
    IpcChannels.APP_EXPORT,
    async (_e, deviceId: string, packageName: string, outputDir: string) => {
      try {
        const r = await exportApk(deviceId, packageName, outputDir);
        recordInteract(packageName, 'export');
        return ok(r);
      } catch (e) { return fail(e); }
    }
  );

  ipcMain.handle(
    IpcChannels.APP_INFO_DETAIL,
    async (_e, deviceId: string, packageName: string, apkPath?: string) => {
      try { return ok(await getAppDetail(deviceId, packageName, apkPath)); } catch (e) { return fail(e); }
    }
  );

  ipcMain.handle(
    IpcChannels.APP_META,
    async (_e, deviceId: string, packageName: string, versionCode?: number) => {
      try { return ok(await getAppMeta(packageName, deviceId, versionCode)); } catch (e) {
        return fail(e);
      }
    }
  );

  ipcMain.handle(
    IpcChannels.APP_META_BATCH,
    async (_e, items: { packageName: string; versionCode?: number }[]) => {
      try { return ok(getAppMetaBatch(items)); } catch (e) { return fail(e); }
    }
  );

  ipcMain.handle(
    IpcChannels.APP_INFO_DETAIL_BATCH,
    async (_e, items: { packageName: string; apkPath?: string }[]) => {
      try { return ok(getAppDetailBatch(items)); } catch (e) { return fail(e); }
    }
  );

  // ================== 文件浏览器 ==================

  ipcMain.handle(IpcChannels.FS_LIST, async (_e, deviceId: string, path: string) => {
    try { return ok(await listDir(deviceId, path)); } catch (e) { return fail(e); }
  });

  // 维护流式 list 的取消标志，按 requestId 索引
  const listStreamCancelTokens = new Map<string, { cancelled: boolean }>();

  ipcMain.handle(IpcChannels.FS_LIST_STREAM_CANCEL, async (_e, requestId: string) => {
    const t = listStreamCancelTokens.get(requestId);
    if (t) t.cancelled = true;
    return ok(true);
  });

  ipcMain.handle(
    IpcChannels.FS_LIST_STREAM,
    async (e, deviceId: string, path: string, requestId: string) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      const cancelToken = { cancelled: false };
      listStreamCancelTokens.set(requestId, cancelToken);
      try {
        const all = await listDirStreaming(
          deviceId,
          path,
          (chunk) => {
            if (cancelToken.cancelled) return;
            win?.webContents.send(IpcChannels.FS_LIST_STREAM_CHUNK, {
              requestId, kind: 'chunk', entries: chunk,
            });
          },
          { cancelToken },
        );
        if (!cancelToken.cancelled) {
          win?.webContents.send(IpcChannels.FS_LIST_STREAM_CHUNK, {
            requestId, kind: 'end', total: all.length,
          });
        }
        return ok({ total: all.length });
      } catch (err) {
        if (!cancelToken.cancelled) {
          win?.webContents.send(IpcChannels.FS_LIST_STREAM_CHUNK, {
            requestId, kind: 'error',
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return fail(err);
      } finally {
        listStreamCancelTokens.delete(requestId);
      }
    }
  );

  ipcMain.handle(IpcChannels.FS_PROBE, async (_e, deviceId: string, path: string) => {
    try { return ok(await probeRemote(deviceId, path)); } catch (e) { return fail(e); }
  });

  ipcMain.handle(IpcChannels.FS_MKDIR, async (_e, deviceId: string, path: string) => {
    try { await mkdirRemote(deviceId, path); return ok(true); } catch (e) { return fail(e); }
  });

  ipcMain.handle(IpcChannels.FS_RM, async (_e, deviceId: string, path: string) => {
    try { await removeRemote(deviceId, path); return ok(true); } catch (e) { return fail(e); }
  });

  ipcMain.handle(IpcChannels.FS_RENAME, async (_e, deviceId: string, from: string, to: string) => {
    try { await renameRemote(deviceId, from, to); return ok(true); } catch (e) { return fail(e); }
  });

  /**
   * 单文件下载（另存为）
   */
  ipcMain.handle(
    IpcChannels.FS_PULL,
    async (e, deviceId: string, remotePath: string, localPath: string, size?: number) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      const id = `pull_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const name = remotePath.split('/').pop() || remotePath;
      win?.webContents.send(IpcChannels.FS_TRANSFER_PROGRESS, {
        id, direction: 'pull', name, status: 'transferring', bytes: 0, totalBytes: size,
      });
      try {
        await pullFile(deviceId, remotePath, localPath, (bytes, total) => {
          win?.webContents.send(IpcChannels.FS_TRANSFER_PROGRESS, {
            id, direction: 'pull', name, status: 'transferring', bytes, totalBytes: total ?? size,
          });
        }, size);
        win?.webContents.send(IpcChannels.FS_TRANSFER_PROGRESS, {
          id, direction: 'pull', name, status: 'success', bytes: size ?? 0, totalBytes: size,
        });
        return ok({ id, localPath });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        win?.webContents.send(IpcChannels.FS_TRANSFER_PROGRESS, {
          id, direction: 'pull', name, status: 'failed', bytes: 0, error: msg,
        });
        return fail(err);
      }
    }
  );

  /**
   * 批量下载到本地目录（支持目录递归）
   */
  ipcMain.handle(
    IpcChannels.FS_PULL_MANY,
    async (
      e,
      deviceId: string,
      items: { path: string; name: string; isDir: boolean; size?: number }[],
      localDir: string,
    ) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      if (!existsSync(localDir)) mkdirSync(localDir, { recursive: true });

      const results: { name: string; ok: boolean; error?: string }[] = [];

      // 递归下载目录：先 listDir -> 再挨个 pull
      async function pullRecursive(remote: string, local: string, displayName: string) {
        const stat = await probeRemote(deviceId, remote);
        if (stat === 'denied') throw new Error('权限被拒');
        if (stat === 'notfound') throw new Error('不存在');
        if (stat === 'file') {
          const id = `pull_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          win?.webContents.send(IpcChannels.FS_TRANSFER_PROGRESS, {
            id, direction: 'pull', name: displayName, status: 'transferring', bytes: 0,
          });
          try {
            await pullFile(deviceId, remote, local, (bytes, total) => {
              win?.webContents.send(IpcChannels.FS_TRANSFER_PROGRESS, {
                id, direction: 'pull', name: displayName, status: 'transferring', bytes, totalBytes: total,
              });
            });
            win?.webContents.send(IpcChannels.FS_TRANSFER_PROGRESS, {
              id, direction: 'pull', name: displayName, status: 'success', bytes: 0,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            win?.webContents.send(IpcChannels.FS_TRANSFER_PROGRESS, {
              id, direction: 'pull', name: displayName, status: 'failed', bytes: 0, error: msg,
            });
            throw err;
          }
          return;
        }
        // 目录：递归
        if (!existsSync(local)) mkdirSync(local, { recursive: true });
        const entries = await listDir(deviceId, remote);
        for (const ent of entries) {
          if (ent.isSymlink) continue; // 跳过 symlink，避免循环
          const childRemote = joinRemote(remote, ent.name);
          const childLocal = joinPath(local, ent.name);
          await pullRecursive(childRemote, childLocal, `${displayName}/${ent.name}`);
        }
      }

      for (const it of items) {
        const targetLocal = joinPath(localDir, it.name);
        try {
          await pullRecursive(it.path, targetLocal, it.name);
          results.push({ name: it.name, ok: true });
        } catch (err) {
          results.push({ name: it.name, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return ok(results);
    }
  );

  /**
   * 批量上传 PC 本地文件（或目录）到远端某目录
   */
  ipcMain.handle(
    IpcChannels.FS_PUSH_MANY,
    async (
      e,
      deviceId: string,
      localPaths: string[],
      remoteDir: string,
    ) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      const results: { name: string; ok: boolean; error?: string }[] = [];

      async function pushRecursive(local: string, remote: string, displayName: string) {
        const st = statSync(local);
        if (st.isDirectory()) {
          try { await mkdirRemote(deviceId, remote); } catch { /* 已存在/忽略 */ }
          const kids = readdirSync(local);
          for (const k of kids) {
            await pushRecursive(joinPath(local, k), joinRemote(remote, k), `${displayName}/${k}`);
          }
          return;
        }
        // 文件
        const id = `push_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const total = st.size;
        win?.webContents.send(IpcChannels.FS_TRANSFER_PROGRESS, {
          id, direction: 'push', name: displayName, status: 'transferring', bytes: 0, totalBytes: total,
        });
        try {
          await pushFile(deviceId, local, remote, (bytes, tot) => {
            win?.webContents.send(IpcChannels.FS_TRANSFER_PROGRESS, {
              id, direction: 'push', name: displayName, status: 'transferring', bytes, totalBytes: tot ?? total,
            });
          });
          win?.webContents.send(IpcChannels.FS_TRANSFER_PROGRESS, {
            id, direction: 'push', name: displayName, status: 'success', bytes: total, totalBytes: total,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          win?.webContents.send(IpcChannels.FS_TRANSFER_PROGRESS, {
            id, direction: 'push', name: displayName, status: 'failed', bytes: 0, totalBytes: total, error: msg,
          });
          throw err;
        }
      }

      for (const p of localPaths) {
        const name = basename(p);
        const targetRemote = joinRemote(remoteDir, name);
        try {
          await pushRecursive(p, targetRemote, name);
          results.push({ name, ok: true });
        } catch (err) {
          results.push({ name, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return ok(results);
    }
  );
}

export function disposeAdb() {
  disposeTracker?.();
  disposeTracker = null;
}
