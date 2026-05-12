/**
 * 主进程与渲染进程共享的类型定义
 */

/** 设备连接状态 */
export type DeviceState = 'device' | 'offline' | 'unauthorized' | 'disconnected';

/** 设备信息 */
export interface DeviceInfo {
  id: string;            // 设备序列号
  state: DeviceState;
  model?: string;        // 设备型号  e.g. Pixel 6
  brand?: string;        // 品牌      e.g. Google
  androidVersion?: string;
  sdkVersion?: string;
  serialno?: string;
  product?: string;
}

/** 已安装应用信息 */
export interface AppInfo {
  packageName: string;       // 包名
  appName?: string;          // 应用显示名（可选，需解析）
  versionName?: string;      // 版本名 e.g. 14.050
  versionCode?: number;      // 版本号
  apkPath?: string;          // APK 在设备上的路径
  apkSize?: number;          // APK 大小（字节）
  dataSize?: number;         // 文档/数据大小（字节）
  isSystem: boolean;         // 是否系统应用
  firstInstallTime?: number;
  lastUpdateTime?: number;
  iconBase64?: string;       // 图标 base64（按需加载）
  // ---- 使用频率（用于排序）----
  deviceUseCount?: number;   // 设备端 appLaunchCount
  pcInteractCount?: number;  // PC 端用户交互次数
  pcInstallAt?: number;      // PC 端最近一次安装时间戳（ms），用于置顶
}

/** 应用类别筛选 */
export type AppCategory = 'all' | 'user' | 'system';

/** 远端文件/目录条目（文件浏览器用） */
export interface RemoteEntry {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  mtimeMs: number;
  mode: number;
}

/** 单个传输任务状态（文件浏览器） */
export type FsTransferStatus = 'pending' | 'transferring' | 'success' | 'failed';
export interface FsTransferProgressMsg {
  id: string;                   // 任务 id（渲染端生成）
  direction: 'pull' | 'push';
  name: string;                 // 文件名展示用
  status: FsTransferStatus;
  bytes: number;
  totalBytes?: number;
  error?: string;
}

/** 安装任务状态 */
export type InstallTaskStatus = 'pending' | 'installing' | 'success' | 'failed';

export interface InstallTask {
  id: string;
  apkPath: string;
  apkName: string;
  deviceId: string;
  status: InstallTaskStatus;
  progress: number;         // 0-100
  error?: string;
}

/** IPC 事件通道名称 */
export const IpcChannels = {
  // 设备相关
  DEVICE_LIST: 'device:list',
  DEVICE_INFO: 'device:info',
  DEVICE_INFO_DETAIL: 'device:info:detail',
  DEVICE_REBOOT: 'device:reboot',
  DEVICE_POWER_OFF: 'device:powerOff',
  DEVICE_SCREENSHOT: 'device:screenshot',
  DEVICE_SCREENSHOT_SAVE: 'device:screenshot:save',
  DEVICE_TRACK: 'device:track',          // 主→渲染: 设备插拔事件

  // 应用相关
  APP_LIST: 'app:list',
  APP_DATA_SIZES: 'app:dataSizes',
  APP_DEVICE_USAGE: 'app:deviceUsage',
  APP_PC_INTERACT_GET: 'app:pcInteract:get',
  APP_PC_INTERACT_RECORD: 'app:pcInteract:record',
  APP_PC_INSTALL_TIMES: 'app:pcInstallTimes:get',
  APP_INFO_DETAIL: 'app:info:detail',
  APP_INFO_DETAIL_BATCH: 'app:info:detail:batch',
  APP_META: 'app:meta',                  // 真实名称 + 图标（懒加载）
  APP_META_BATCH: 'app:meta:batch',      // 批量读取所有缓存命中的 meta
  APP_INSTALL: 'app:install',
  APP_UNINSTALL: 'app:uninstall',
  APP_EXPORT: 'app:export',              // 导出 APK 到本地
  APP_INSTALL_PROGRESS: 'app:install:progress', // 主→渲染

  // 文件浏览器（应用文档目录）
  FS_LIST: 'fs:list',
  FS_LIST_STREAM: 'fs:listStream',           // 流式列目录
  FS_LIST_STREAM_CHUNK: 'fs:listStream:chunk',// 主→渲染：流式 chunk
  FS_LIST_STREAM_CANCEL: 'fs:listStream:cancel',
  FS_PROBE: 'fs:probe',
  FS_PULL: 'fs:pull',                    // 单个下载
  FS_PULL_MANY: 'fs:pullMany',           // 批量下载（可含目录）
  FS_PUSH_MANY: 'fs:pushMany',           // 批量上传（支持目录）
  FS_MKDIR: 'fs:mkdir',
  FS_RM: 'fs:rm',
  FS_RENAME: 'fs:rename',
  FS_TRANSFER_PROGRESS: 'fs:transfer:progress', // 主→渲染：传输进度

  // 工具
  DIALOG_OPEN_APK: 'dialog:openApk',
  DIALOG_OPEN_DIR: 'dialog:openDir',
  DIALOG_SAVE_FILE: 'dialog:saveFile',   // 保存单文件对话框
  DIALOG_OPEN_FILES: 'dialog:openFiles', // 任意多文件选择（用于上传）

  // 窗口控制
  WIN_MINIMIZE: 'win:minimize',
  WIN_MAXIMIZE: 'win:maximize',   // 最大化/还原切换
  WIN_CLOSE: 'win:close',
} as const;

export type IpcChannel = typeof IpcChannels[keyof typeof IpcChannels];

/** 统一的 IPC 返回结构 */
export interface IpcResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
