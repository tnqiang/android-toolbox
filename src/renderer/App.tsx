import { useCallback, useEffect, useRef, useState } from 'react';
import { App as AntdApp } from 'antd';
import TopBar from './components/TopBar';
import Sidebar from './components/Sidebar';
import StatusBar from './components/StatusBar';
import TaskPanel from './components/TaskPanel';
import AppsPage from './pages/Apps';
import DeviceInfoPage from './pages/DeviceInfo';
import { useAppStore } from './store/useAppStore';
import { useTaskStore } from './store/useTaskStore';

export default function App() {
  const [section, setSection] = useState<string>('info');
  const setDevices = useAppStore((s) => s.setDevices);
  const currentDeviceId = useAppStore((s) => s.currentDeviceId);
  const { message } = AntdApp.useApp();

  // 拖拽遮罩显示状态
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);

  /**
   * 安装一组 apk 路径（拖拽 / 双击 apk 文件关联 / 首次启动 argv 复用此入口）
   * - 自动过滤非 .apk
   * - 当前没有连接设备时给出提示并把路径暂存，待设备连入再自动重试
   */
  const pendingApkQueueRef = useRef<string[]>([]);
  const installApkPaths = useCallback((rawPaths: string[]) => {
    const apkPaths = (rawPaths || []).filter((p) => p && /\.apk$/i.test(p));
    if (apkPaths.length === 0) return;

    const deviceId = useAppStore.getState().currentDeviceId;
    if (!deviceId) {
      // 还没有选中的设备：先暂存，等设备连入再装
      for (const p of apkPaths) {
        if (!pendingApkQueueRef.current.includes(p)) {
          pendingApkQueueRef.current.push(p);
        }
      }
      message.warning('请先连接安卓设备，APK 已加入等待队列');
      return;
    }

    // 立刻把任务插入面板（installing 状态 0%）
    const ts = useTaskStore.getState();
    for (const p of apkPaths) {
      ts.upsertTask({ apk: p, status: 'installing', percent: 0, stage: 'starting' });
    }

    window.api.installApks(deviceId, apkPaths).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[install] error', err);
    });
  }, [message]);

  // 启动设备追踪
  useEffect(() => {
    let unbind: (() => void) | undefined;
    (async () => {
      const start = await window.api.startDeviceTrack();
      if (!start.ok) {
        message.error(`无法启动 adb 服务：${start.error}`);
      }
      unbind = window.api.onDeviceChange((devices) => {
        setDevices(devices);
      });
    })();
    return () => unbind?.();
  }, [setDevices, message]);

  // 全局监听安装进度，写入 TaskStore
  useEffect(() => {
    const off = window.api.onInstallProgress((msg) => {
      useTaskStore.getState().upsertTask({
        apk: msg.apk,
        status: msg.status,
        percent: msg.percent,
        stage: msg.stage,
        error: msg.error,
      });

      // —— 安装成功后：立即做一次单行增量刷新，避免等到用户手动刷新才看到图标/名字 ——
      if (msg.status === 'success' && msg.packageName) {
        const pkg = msg.packageName;
        const installedAt = Date.now();
        const deviceId = useAppStore.getState().currentDeviceId;
        if (!deviceId) return;

        (async () => {
          try {
            // 1) 拉最新 pm list，找到该行的 apkPath / isSystem（pm list 是秒返回的）
            const listResp = await window.api.listApps(deviceId, 'all');
            const fresh = listResp.ok
              ? (listResp.data ?? []).find((a) => a.packageName === pkg)
              : undefined;

            // 2) meta 已在 main 侧从本地 APK 预写缓存 —— 直接命中
            const metaResp = await window.api.getAppMetaBatch([{ packageName: pkg }]);
            const metaHit = metaResp.ok && metaResp.data?.[0];

            // 3) detail 拉一次（装完缓存已清，会走真实查询）
            const detailResp = fresh
              ? await window.api.getAppDetail(deviceId, pkg, fresh.apkPath)
              : null;

            useAppStore.setState((s) => {
              const idx = s.apps.findIndex((a) => a.packageName === pkg);
              const base = fresh ?? s.apps[idx] ?? { packageName: pkg, isSystem: false };
              const merged = {
                ...base,
                ...(idx >= 0 ? s.apps[idx] : {}),
                ...(fresh ?? {}),
                ...(detailResp?.ok ? detailResp.data : {}),
                ...(metaHit
                  ? {
                    appName: metaHit.label ?? undefined,
                    iconBase64: metaHit.iconBase64 ?? undefined,
                  }
                  : {}),
                // 打上"本次安装时间戳"，让排序将它置顶
                pcInstallAt: installedAt,
              };
              const next = s.apps.slice();
              if (idx >= 0) next[idx] = merged;
              else next.unshift(merged);
              return { apps: next };
            });
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[install-success] incremental refresh error', err);
          }
        })();
      }
    });
    return () => { off?.(); };
  }, []);

  // 拖拽 APK 到窗口自动安装
  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      // 如果文件浏览器已打开，交给它处理（它用 capture 先接收）
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((window as any).__fileBrowserOpen) return;
      e.preventDefault();
      if (!e.dataTransfer?.types?.includes('Files')) return;
      dragCounter.current++;
      setDragOver(true);
    };
    const onDragOver = (e: DragEvent) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((window as any).__fileBrowserOpen) return;
      e.preventDefault();
    };
    const onDragLeave = (e: DragEvent) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((window as any).__fileBrowserOpen) return;
      e.preventDefault();
      dragCounter.current = Math.max(0, dragCounter.current - 1);
      if (dragCounter.current === 0) setDragOver(false);
    };

    const onDrop = (e: DragEvent) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((window as any).__fileBrowserOpen) return;
      e.preventDefault();
      dragCounter.current = 0;
      setDragOver(false);

      try {
        const fileList = e.dataTransfer?.files;
        if (!fileList || fileList.length === 0) return;

        // 逐个 File 通过 preload 拿路径
        const paths: string[] = [];
        for (let i = 0; i < fileList.length; i++) {
          const f = fileList[i];
          if (!f) continue;
          const p = window.api.getPathForFile(f);
          if (p) paths.push(p);
        }
        const apkPaths = paths.filter((p) => /\.apk$/i.test(p));
        if (apkPaths.length === 0) { message.warning('未检测到 APK 文件'); return; }
        installApkPaths(apkPaths);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[drop] error', err);
      }
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [currentDeviceId, message, installApkPaths]);

  // 文件关联：双击 .apk 自动安装
  // - 启动时拉取一次（首次启动 argv 带的 apk）
  // - 运行期监听（已运行时再次双击 apk）
  useEffect(() => {
    let off: (() => void) | undefined;
    (async () => {
      try {
        const resp = await window.api.fetchPendingApkOpens();
        if (resp.ok && resp.data && resp.data.length > 0) {
          installApkPaths(resp.data);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[apk-open] fetch error', err);
      }
      off = window.api.onApkOpenRequest((paths) => {
        installApkPaths(paths);
      });
    })();
    return () => { off?.(); };
  }, [installApkPaths]);

  // 设备从无到有连入时：把暂存的 apk 队列冲掉
  useEffect(() => {
    if (!currentDeviceId) return;
    const queued = pendingApkQueueRef.current.slice();
    if (queued.length === 0) return;
    pendingApkQueueRef.current = [];
    installApkPaths(queued);
  }, [currentDeviceId, installApkPaths]);

  return (
    <>
      <TopBar />
      <div className="app-body">
        <Sidebar section={section} onSectionChange={setSection} />
        <div className="app-content">
          {section === 'info' && <DeviceInfoPage />}
          {section === 'apps' && <AppsPage />}
          {section !== 'info' && section !== 'apps' && (
            <div style={{ padding: 24, color: '#8c8c8c' }}>
              「{section}」模块开发中…
            </div>
          )}
        </div>
      </div>
      <StatusBar />
      <TaskPanel />
      {dragOver && (
        <div className="drop-overlay">
          📦 松开以安装 APK
        </div>
      )}
    </>
  );
}
