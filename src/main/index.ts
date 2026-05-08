import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron';
import { join } from 'path';
import { existsSync } from 'fs';
import { registerAdbHandlers, disposeAdb } from './adb/handlers';
import { IpcChannels } from '../shared/types';

// 全局异常兜底：避免任何未捕获异常导致 Electron 整体崩溃
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('[main] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[main] unhandledRejection:', reason);
});

const isDev = !app.isPackaged;

// 移除默认应用菜单（File/Edit/View...）
Menu.setApplicationMenu(null);

let mainWindow: BrowserWindow | null = null;

async function createWindow() {
  // 窗口图标：dev 用项目 resources 下的；生产用打包进 resources 的
  // Windows 用 .ico 效果最好；macOS 的 dock 图标由 electron-builder 的 .icns 控制，这里传 .png 也能用
  const iconCandidates = app.isPackaged
    ? [
      join(process.resourcesPath, 'icon.ico'),
      join(process.resourcesPath, 'icon.png'),
    ]
    : [
      join(process.cwd(), 'resources', 'icon.ico'),
      join(process.cwd(), 'resources', 'icon', 'icon.png'),
    ];
  const iconPath = iconCandidates.find((p) => existsSync(p));

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 680,
    title: '手机助手',
    backgroundColor: '#f5f7fa',
    show: false,
    frame: false,            // 移除原生标题栏
    autoHideMenuBar: true,   // 保险：彻底隐藏菜单栏
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // 外链交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev && process.env['VITE_DEV_SERVER_URL']) {
    await mainWindow.loadURL(process.env['VITE_DEV_SERVER_URL']);
    // 注意：Electron 32.x 在 Windows 上 mode:'detach' 与拖拽事件结合时偶发 native crash
    // 改为默认 bottom 模式规避
    mainWindow.webContents.openDevTools({ mode: 'bottom' });
  } else {
    const indexHtml = join(__dirname, '../../dist/index.html');
    if (existsSync(indexHtml)) {
      await mainWindow.loadFile(indexHtml);
    }
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** 注册系统级 IPC（如文件选择对话框、窗口控制） */
function registerSystemHandlers() {
  ipcMain.handle(IpcChannels.DIALOG_OPEN_APK, async () => {
    if (!mainWindow) return { ok: false, error: 'window not ready' };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 APK 文件',
      filters: [{ name: 'Android Package', extensions: ['apk'] }],
      properties: ['openFile', 'multiSelections'],
    });
    return { ok: !result.canceled, data: result.filePaths };
  });

  ipcMain.handle(IpcChannels.DIALOG_OPEN_DIR, async () => {
    if (!mainWindow) return { ok: false, error: 'window not ready' };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择导出目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    return { ok: !result.canceled, data: result.filePaths[0] };
  });

  ipcMain.handle(IpcChannels.DIALOG_SAVE_FILE, async (_e, suggestedName?: string) => {
    if (!mainWindow) return { ok: false, error: 'window not ready' };
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '保存文件',
      defaultPath: suggestedName,
    });
    return { ok: !result.canceled && !!result.filePath, data: result.filePath };
  });

  ipcMain.handle(IpcChannels.DIALOG_OPEN_FILES, async () => {
    if (!mainWindow) return { ok: false, error: 'window not ready' };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择要上传的文件',
      properties: ['openFile', 'multiSelections'],
    });
    return { ok: !result.canceled, data: result.filePaths };
  });

  // 窗口控制（frame: false 下需要自实现）
  ipcMain.handle(IpcChannels.WIN_MINIMIZE, () => mainWindow?.minimize());
  ipcMain.handle(IpcChannels.WIN_MAXIMIZE, () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle(IpcChannels.WIN_CLOSE, () => mainWindow?.close());
}

app.whenReady().then(async () => {
  registerSystemHandlers();
  registerAdbHandlers(() => mainWindow);
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  disposeAdb();
});
