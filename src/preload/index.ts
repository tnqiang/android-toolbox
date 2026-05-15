/**
 * Preload：通过 contextBridge 把受控的 IPC API 暴露给渲染进程
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IpcChannels } from '../shared/types';
import type {
  AppCategory, AppInfo, DeviceInfo, IpcResult,
  RemoteEntry, FsTransferProgressMsg, MediaEntry, MediaKind,
} from '../shared/types';

const api = {
  // ---- 设备 ----
  listDevices: (): Promise<IpcResult<DeviceInfo[]>> =>
    ipcRenderer.invoke(IpcChannels.DEVICE_LIST),

  getDeviceDetailInfo: (deviceId: string): Promise<IpcResult<any>> =>
    ipcRenderer.invoke(IpcChannels.DEVICE_INFO_DETAIL, deviceId),

  rebootDevice: (deviceId: string): Promise<IpcResult<true>> =>
    ipcRenderer.invoke(IpcChannels.DEVICE_REBOOT, deviceId),

  powerOffDevice: (deviceId: string): Promise<IpcResult<true>> =>
    ipcRenderer.invoke(IpcChannels.DEVICE_POWER_OFF, deviceId),

  takeScreenshot: (deviceId: string): Promise<IpcResult<{ image: string; rotation: 0 | 90 | 180 | 270 }>> =>
    ipcRenderer.invoke(IpcChannels.DEVICE_SCREENSHOT, deviceId),

  /** 弹"另存为"对话框并把 base64 PNG 写入磁盘；取消返回 ok=false, error="canceled" */
  saveScreenshot: (base64: string, suggestedName?: string): Promise<IpcResult<string>> =>
    ipcRenderer.invoke(IpcChannels.DEVICE_SCREENSHOT_SAVE, base64, suggestedName),

  startDeviceTrack: (): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke(IpcChannels.DEVICE_TRACK),

  onDeviceChange: (listener: (devices: DeviceInfo[]) => void) => {
    const handler = (_: unknown, devices: DeviceInfo[]) => listener(devices);
    ipcRenderer.on(IpcChannels.DEVICE_TRACK, handler);
    return () => ipcRenderer.removeListener(IpcChannels.DEVICE_TRACK, handler);
  },

  // ---- 应用 ----
  listApps: (deviceId: string, category: AppCategory = 'user'): Promise<IpcResult<AppInfo[]>> =>
    ipcRenderer.invoke(IpcChannels.APP_LIST, deviceId, category),

  getAllAppDataSizes: (deviceId: string): Promise<IpcResult<Record<string, number>>> =>
    ipcRenderer.invoke(IpcChannels.APP_DATA_SIZES, deviceId),

  getDeviceAppUsage: (deviceId: string): Promise<IpcResult<Record<string, number>>> =>
    ipcRenderer.invoke(IpcChannels.APP_DEVICE_USAGE, deviceId),

  getPcInteractScores: (): Promise<IpcResult<Record<string, number>>> =>
    ipcRenderer.invoke(IpcChannels.APP_PC_INTERACT_GET),

  getPcInstallTimes: (): Promise<IpcResult<Record<string, number>>> =>
    ipcRenderer.invoke(IpcChannels.APP_PC_INSTALL_TIMES),

  recordInteract: (
    packageName: string,
    kind: 'install' | 'uninstall' | 'export' | 'view',
  ): Promise<IpcResult<true>> =>
    ipcRenderer.invoke(IpcChannels.APP_PC_INTERACT_RECORD, packageName, kind),

  getAppDetail: (deviceId: string, packageName: string, apkPath?: string): Promise<IpcResult<Partial<AppInfo>>> =>
    ipcRenderer.invoke(IpcChannels.APP_INFO_DETAIL, deviceId, packageName, apkPath),

  getAppMeta: (
    deviceId: string,
    packageName: string,
    versionCode?: number,
  ): Promise<IpcResult<{ packageName: string; label?: string; iconBase64?: string; versionCode?: number }>> =>
    ipcRenderer.invoke(IpcChannels.APP_META, deviceId, packageName, versionCode),

  getAppMetaBatch: (
    items: { packageName: string; versionCode?: number }[],
  ): Promise<IpcResult<Array<{ packageName: string; label?: string; iconBase64?: string; versionCode?: number }>>> =>
    ipcRenderer.invoke(IpcChannels.APP_META_BATCH, items),

  getAppDetailBatch: (
    items: { packageName: string; apkPath?: string }[],
  ): Promise<IpcResult<Array<{ packageName: string; detail: Partial<AppInfo> }>>> =>
    ipcRenderer.invoke(IpcChannels.APP_INFO_DETAIL_BATCH, items),

  installApks: (deviceId: string, apkPaths: string[]) =>
    ipcRenderer.invoke(IpcChannels.APP_INSTALL, deviceId, apkPaths),

  uninstallApp: (deviceId: string, packageName: string): Promise<IpcResult<true>> =>
    ipcRenderer.invoke(IpcChannels.APP_UNINSTALL, deviceId, packageName),

  exportApk: (deviceId: string, packageName: string, outputDir: string): Promise<IpcResult<string>> =>
    ipcRenderer.invoke(IpcChannels.APP_EXPORT, deviceId, packageName, outputDir),

  onInstallProgress: (
    listener: (msg: {
      apk: string;
      status: 'installing' | 'success' | 'failed';
      percent?: number;
      stage?: string;
      error?: string;
      packageName?: string;
    }) => void
  ) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (_: unknown, msg: any) => listener(msg);
    ipcRenderer.on(IpcChannels.APP_INSTALL_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IpcChannels.APP_INSTALL_PROGRESS, handler);
  },

  // ---- 对话框 ----
  pickApks: (): Promise<IpcResult<string[]>> =>
    ipcRenderer.invoke(IpcChannels.DIALOG_OPEN_APK),
  pickDirectory: (): Promise<IpcResult<string>> =>
    ipcRenderer.invoke(IpcChannels.DIALOG_OPEN_DIR),
  pickSaveFile: (suggestedName?: string): Promise<IpcResult<string>> =>
    ipcRenderer.invoke(IpcChannels.DIALOG_SAVE_FILE, suggestedName),
  pickFiles: (): Promise<IpcResult<string[]>> =>
    ipcRenderer.invoke(IpcChannels.DIALOG_OPEN_FILES),

  // ---- 文件浏览器 ----
  fsList: (deviceId: string, path: string): Promise<IpcResult<RemoteEntry[]>> =>
    ipcRenderer.invoke(IpcChannels.FS_LIST, deviceId, path),

  /** 流式列目录：onChunk 持续触发 chunk/end/error 事件；返回 cancel 句柄 */
  fsListStream: (
    deviceId: string,
    path: string,
    onChunk: (msg:
      | { kind: 'chunk'; entries: RemoteEntry[] }
      | { kind: 'end'; total: number }
      | { kind: 'error'; error: string }
    ) => void,
  ): { cancel: () => void; done: Promise<IpcResult<{ total: number }>> } => {
    const requestId = `ls_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const handler = (
      _e: unknown,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      msg: any,
    ) => {
      if (!msg || msg.requestId !== requestId) return;
      if (msg.kind === 'chunk') {
        onChunk({ kind: 'chunk', entries: msg.entries });
      } else if (msg.kind === 'end') {
        onChunk({ kind: 'end', total: msg.total });
        ipcRenderer.removeListener(IpcChannels.FS_LIST_STREAM_CHUNK, handler);
      } else if (msg.kind === 'error') {
        onChunk({ kind: 'error', error: msg.error });
        ipcRenderer.removeListener(IpcChannels.FS_LIST_STREAM_CHUNK, handler);
      }
    };
    ipcRenderer.on(IpcChannels.FS_LIST_STREAM_CHUNK, handler);

    const done = ipcRenderer.invoke(
      IpcChannels.FS_LIST_STREAM, deviceId, path, requestId,
    ) as Promise<IpcResult<{ total: number }>>;

    return {
      cancel: () => {
        ipcRenderer.removeListener(IpcChannels.FS_LIST_STREAM_CHUNK, handler);
        ipcRenderer.invoke(IpcChannels.FS_LIST_STREAM_CANCEL, requestId);
      },
      done,
    };
  },
  fsProbe: (deviceId: string, path: string): Promise<IpcResult<'dir' | 'file' | 'notfound' | 'denied'>> =>
    ipcRenderer.invoke(IpcChannels.FS_PROBE, deviceId, path),
  fsMkdir: (deviceId: string, path: string): Promise<IpcResult<true>> =>
    ipcRenderer.invoke(IpcChannels.FS_MKDIR, deviceId, path),
  fsRm: (deviceId: string, path: string): Promise<IpcResult<true>> =>
    ipcRenderer.invoke(IpcChannels.FS_RM, deviceId, path),
  fsRename: (deviceId: string, from: string, to: string): Promise<IpcResult<true>> =>
    ipcRenderer.invoke(IpcChannels.FS_RENAME, deviceId, from, to),
  fsPull: (
    deviceId: string, remotePath: string, localPath: string, size?: number,
  ): Promise<IpcResult<{ id: string; localPath: string }>> =>
    ipcRenderer.invoke(IpcChannels.FS_PULL, deviceId, remotePath, localPath, size),
  fsPullMany: (
    deviceId: string,
    items: { path: string; name: string; isDir: boolean; size?: number }[],
    localDir: string,
  ): Promise<IpcResult<{ name: string; ok: boolean; error?: string }[]>> =>
    ipcRenderer.invoke(IpcChannels.FS_PULL_MANY, deviceId, items, localDir),
  fsPushMany: (
    deviceId: string, localPaths: string[], remoteDir: string,
  ): Promise<IpcResult<{ name: string; ok: boolean; error?: string }[]>> =>
    ipcRenderer.invoke(IpcChannels.FS_PUSH_MANY, deviceId, localPaths, remoteDir),

  onFsTransferProgress: (listener: (msg: FsTransferProgressMsg) => void) => {
    const handler = (_: unknown, msg: FsTransferProgressMsg) => listener(msg);
    ipcRenderer.on(IpcChannels.FS_TRANSFER_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IpcChannels.FS_TRANSFER_PROGRESS, handler);
  },

  /**
   * 传入单个 File 对象，返回其绝对路径。
   * 关键：必须逐个传，不能传 FileList；contextBridge 处理 FileList 会丢失内容。
   */
  getPathForFile: (file: File): string => {
    try {
      if (!file) return '';
      return webUtils.getPathForFile(file) || '';
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[preload] getPathForFile error:', e);
      return '';
    }
  },

  /**
   * 兼容旧签名：接受 FileList 但内部逐个转换。
   * 注意：File 通过 contextBridge 会 clone，这个函数通常返回空，
   * 推荐渲染层用 getPathForFile 逐个调用。
   */
  getPathsFromFiles: (files: File[] | FileList): string[] => {
    try {
      if (!files) return [];
      const result: string[] = [];
      const len = (files as FileList).length ?? 0;
      for (let i = 0; i < len; i++) {
        const f = (files as FileList)[i];
        if (!f) continue;
        try {
          const p = webUtils.getPathForFile(f);
          if (p && typeof p === 'string') result.push(p);
        } catch { /* ignore */ }
      }
      return result;
    } catch {
      return [];
    }
  },

  // ---- 窗口控制 ----
  winMinimize: () => ipcRenderer.invoke(IpcChannels.WIN_MINIMIZE),
  winMaximize: () => ipcRenderer.invoke(IpcChannels.WIN_MAXIMIZE),
  winClose: () => ipcRenderer.invoke(IpcChannels.WIN_CLOSE),

  // ---- 媒体（相册/视频） ----
  /** 扫描设备上的媒体文件（按 mtime 倒序） */
  mediaScan: (
    deviceId: string,
    kind: MediaKind,
    opts?: { roots?: string[]; exts?: string[] },
  ): Promise<IpcResult<MediaEntry[]>> =>
    ipcRenderer.invoke(IpcChannels.MEDIA_SCAN, deviceId, kind, opts),

  /** 拉到本地缓存并返回 file:// URL（同一文件只拉一次） */
  mediaLocalUrl: (
    deviceId: string,
    entry: { path: string; mtimeMs: number; size: number },
  ): Promise<IpcResult<string>> =>
    ipcRenderer.invoke(IpcChannels.MEDIA_LOCAL_URL, deviceId, entry),

  /** 在系统文件管理器中显示本地缓存文件 */
  mediaReveal: (localUrl: string): Promise<IpcResult<true>> =>
    ipcRenderer.invoke(IpcChannels.MEDIA_REVEAL, localUrl),

  // ---- 文件关联：双击 apk 启动 ----
  /** 渲染进程启动后调用一次，拿走启动至今的所有待安装 apk 路径 */
  fetchPendingApkOpens: (): Promise<IpcResult<string[]>> =>
    ipcRenderer.invoke(IpcChannels.APK_OPEN_FETCH),

  /** 监听运行期 apk 打开事件（已运行时用户再次双击 apk） */
  onApkOpenRequest: (listener: (paths: string[]) => void) => {
    const handler = (_: unknown, paths: string[]) => listener(paths);
    ipcRenderer.on(IpcChannels.APK_OPEN_REQUEST, handler);
    return () => ipcRenderer.removeListener(IpcChannels.APK_OPEN_REQUEST, handler);
  },
};

contextBridge.exposeInMainWorld('api', api);

// 启动时在渲染进程 DevTools 中打印可用的 API，方便排查
// eslint-disable-next-line no-console
console.log('[preload] exposed api methods:', Object.keys(api));

export type ApiType = typeof api;
