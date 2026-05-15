import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Input, Table, Popconfirm, App as AntdApp, Empty, Dropdown,
} from 'antd';
import type { MenuProps } from 'antd';
import {
  ImportOutlined, DeleteOutlined, ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useAppStore } from '../store/useAppStore';
import { useTaskStore } from '../store/useTaskStore';
import FileBrowserDrawer from '../components/FileBrowserDrawer';
import type { AppCategory, AppInfo } from '@shared/types';

/** 字节数格式化 */
function fmtSize(n?: number): string {
  if (n == null) return '读取中';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 包名 → 显示名（缺乏 aapt 时的 fallback：取最后一段并首字母大写） */
function fallbackAppName(pkg: string) {
  const last = pkg.split('.').pop() || pkg;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

/** 包名首字母（图标占位） */
function pkgInitial(pkg: string) {
  const m = (pkg.split('.').pop() || pkg).match(/[a-zA-Z\u4e00-\u9fa5]/);
  return (m?.[0] ?? '?').toUpperCase();
}

export default function AppsPage() {
  const currentDeviceId = useAppStore((s) => s.currentDeviceId);
  const apps = useAppStore((s) => s.apps);
  const setApps = useAppStore((s) => s.setApps);
  const category = useAppStore((s) => s.appCategory);
  const setCategory = useAppStore((s) => s.setAppCategory);
  const loading = useAppStore((s) => s.appsLoading);
  const setLoading = useAppStore((s) => s.setAppsLoading);
  const { message } = AntdApp.useApp();

  const [keyword, setKeyword] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);

  // 文件浏览器抽屉
  const [browserTarget, setBrowserTarget] = useState<AppInfo | null>(null);

  // 表格容器高度：Ant Table 的 scroll.y 必须是明确的 px，用 ResizeObserver 动态算
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const [tableBodyHeight, setTableBodyHeight] = useState<number>(0);
  const lastHeightRef = useRef(0);

  const computeTableHeight = useCallback(() => {
    const el = tableWrapRef.current;
    if (!el) return;
    const h = el.clientHeight - 48; // 减表头高度
    if (h > 0 && h !== lastHeightRef.current) {
      lastHeightRef.current = h;
      setTableBodyHeight(h);
    }
  }, []);

  useEffect(() => {
    const el = tableWrapRef.current;
    if (!el) return;

    computeTableHeight();
    const raf1 = requestAnimationFrame(computeTableHeight);
    const raf2 = requestAnimationFrame(() => requestAnimationFrame(computeTableHeight));

    const ro = new ResizeObserver(computeTableHeight);
    ro.observe(el);
    window.addEventListener('resize', computeTableHeight);

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      ro.disconnect();
      window.removeEventListener('resize', computeTableHeight);
    };
  }, [computeTableHeight]);

  // meta 懒加载：记录当前批次，切换设备或刷新时取消旧批次
  const metaBatchRef = useRef(0);

  /**
   * 顺序低并发拉取 meta（真实名称 + 图标）
   * 不阻塞 refresh；每拿到一个就更新一行；切换设备/刷新时自动作废
   */
  const loadMetaSequential = useCallback(
    async (deviceId: string, list: AppInfo[]) => {
      const batchId = ++metaBatchRef.current;
      const concurrency = 12;
      let idx = 0;

      // 累积式更新：合并多个结果 -> 每 100ms flush 一次到 store
      const pendingUpdates = new Map<string, Partial<AppInfo>>();
      let flushTimer: ReturnType<typeof setTimeout> | null = null;

      const flush = () => {
        flushTimer = null;
        if (pendingUpdates.size === 0) return;
        if (metaBatchRef.current !== batchId) return;
        const snapshot = new Map(pendingUpdates);
        pendingUpdates.clear();
        useAppStore.setState((s) => {
          const arr = s.apps.slice();
          for (const [pkg, patch] of snapshot) {
            const j = arr.findIndex((a) => a.packageName === pkg);
            if (j >= 0) arr[j] = { ...arr[j], ...patch };
          }
          return { apps: arr };
        });
      };
      const scheduleFlush = () => {
        if (flushTimer != null) return;
        flushTimer = setTimeout(flush, 100);
      };

      const work = async () => {
        while (idx < list.length) {
          if (metaBatchRef.current !== batchId) return;
          const i = idx++;
          const item = list[i];
          if (item.appName && item.iconBase64) continue;
          try {
            const r = await window.api.getAppMeta(
              deviceId,
              item.packageName,
              item.versionCode,
            );
            if (metaBatchRef.current !== batchId) return;
            if (r.ok && r.data) {
              const { label, iconBase64 } = r.data;
              const patch: Partial<AppInfo> = {};
              if (label) patch.appName = label;
              if (iconBase64) patch.iconBase64 = iconBase64;
              if (Object.keys(patch).length > 0) {
                pendingUpdates.set(item.packageName, patch);
                scheduleFlush();
              }
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[ui] meta fetch error', item.packageName, err);
          }
        }
      };

      await Promise.all(Array.from({ length: concurrency }, work));
      if (flushTimer != null) clearTimeout(flushTimer);
      flush();
    },
    [],
  );

  /**
   * 顺序低并发拉取 detail（版本号/大小），有缓存则极快
   */
  const detailBatchRef = useRef(0);
  const loadDetailsBackground = useCallback(
    async (deviceId: string, list: AppInfo[]) => {
      const batchId = ++detailBatchRef.current;
      const concurrency = 12; // 缓存命中场景，并发可以更高
      let idx = 0;

      const pendingUpdates = new Map<string, Partial<AppInfo>>();
      let flushTimer: ReturnType<typeof setTimeout> | null = null;

      const flush = () => {
        flushTimer = null;
        if (pendingUpdates.size === 0) return;
        if (detailBatchRef.current !== batchId) return;
        const snapshot = new Map(pendingUpdates);
        pendingUpdates.clear();
        useAppStore.setState((s) => {
          const arr = s.apps.slice();
          for (const [pkg, patch] of snapshot) {
            const j = arr.findIndex((a) => a.packageName === pkg);
            if (j >= 0) arr[j] = { ...arr[j], ...patch };
          }
          return { apps: arr };
        });
      };
      const scheduleFlush = () => {
        if (flushTimer != null) return;
        flushTimer = setTimeout(flush, 100);
      };

      const work = async () => {
        while (idx < list.length) {
          if (detailBatchRef.current !== batchId) return;
          const i = idx++;
          const item = list[i];
          if (item.versionName && item.apkSize != null) continue;
          try {
            const r = await window.api.getAppDetail(
              deviceId, item.packageName, item.apkPath,
            );
            if (detailBatchRef.current !== batchId) return;
            if (r.ok && r.data && Object.keys(r.data).length > 0) {
              pendingUpdates.set(item.packageName, r.data);
              scheduleFlush();
            }
          } catch { /* ignore */ }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, work));
      if (flushTimer != null) clearTimeout(flushTimer);
      flush();
    },
    [],
  );

  const refresh = useCallback(async () => {
    if (!currentDeviceId) {
      setApps([]);
      return;
    }
    setLoading(true);
    try {
      // 一次性拉所有应用（系统+用户），前端按 isSystem 分类
      const r = await window.api.listApps(currentDeviceId, 'all');
      if (!r.ok) {
        message.error(`获取应用列表失败：${r.error}`);
        setApps([]);
        return;
      }
      const list = (r.data ?? []).sort((a, b) =>
        a.packageName.localeCompare(b.packageName)
      );

      // ----- 关键优化：先批量读取所有缓存命中的 detail + meta（仅 2 次 IPC）-----
      const tBatch = performance.now();
      const detailReq = list.map((a) => ({ packageName: a.packageName, apkPath: a.apkPath }));
      const metaReq = list.map((a) => ({ packageName: a.packageName, versionCode: a.versionCode }));
      const [detailBatch, metaBatch] = await Promise.all([
        window.api.getAppDetailBatch(detailReq),
        window.api.getAppMetaBatch(metaReq),
      ]);
      const detailMap = new Map<string, Partial<AppInfo>>();
      if (detailBatch.ok && detailBatch.data) {
        for (const it of detailBatch.data) detailMap.set(it.packageName, it.detail);
      }
      const metaMap = new Map<string, { label?: string; iconBase64?: string }>();
      if (metaBatch.ok && metaBatch.data) {
        for (const it of metaBatch.data) {
          metaMap.set(it.packageName, { label: it.label, iconBase64: it.iconBase64 });
        }
      }
      const enriched: AppInfo[] = list.map((a) => ({
        ...a,
        ...(detailMap.get(a.packageName) ?? {}),
        ...(() => {
          const m = metaMap.get(a.packageName);
          if (!m) return {};
          return {
            appName: m.label ?? undefined,
            iconBase64: m.iconBase64 ?? undefined,
          };
        })(),
      }));
      // eslint-disable-next-line no-console
      console.log(`[ui] batch enrich ${list.length} apps in ${(performance.now() - tBatch).toFixed(0)}ms (${detailMap.size} detail hit, ${metaMap.size} meta hit)`);

      // 立即把基础列表显示出来 + 关闭 loading
      setApps(enriched);
      setLoading(false);

      // 后台单个 IPC 补未命中的 detail / meta（只处理缓存未命中的）
      const detailMisses = enriched.filter((a) => !detailMap.has(a.packageName));
      const metaMisses = enriched.filter((a) => !metaMap.has(a.packageName));
      if (detailMisses.length > 0) loadDetailsBackground(currentDeviceId, detailMisses);
      if (metaMisses.length > 0) loadMetaSequential(currentDeviceId, metaMisses);

      // 后台一次性拉取所有应用的「文档大小」（dumpsys diskstats 一条 shell）
      window.api.getAllAppDataSizes(currentDeviceId).then((sizesResp) => {
        if (!sizesResp.ok || !sizesResp.data) return;
        const sizeMap = sizesResp.data;
        useAppStore.setState((s) => ({
          apps: s.apps.map((a) => {
            const ds = sizeMap[a.packageName];
            if (ds == null || a.dataSize === ds) return a;
            return { ...a, dataSize: ds };
          }),
        }));
      });

      // 后台拉取使用频率：设备端 + PC 端 + PC 端安装时间（合并到 store）
      Promise.all([
        window.api.getDeviceAppUsage(currentDeviceId),
        window.api.getPcInteractScores(),
        window.api.getPcInstallTimes(),
      ]).then(([devResp, pcResp, instResp]) => {
        const devMap = devResp.ok && devResp.data ? devResp.data : {};
        const pcMap = pcResp.ok && pcResp.data ? pcResp.data : {};
        const instMap = instResp.ok && instResp.data ? instResp.data : {};
        useAppStore.setState((s) => ({
          apps: s.apps.map((a) => ({
            ...a,
            deviceUseCount: devMap[a.packageName] ?? a.deviceUseCount,
            pcInteractCount: pcMap[a.packageName] ?? a.pcInteractCount,
            pcInstallAt: instMap[a.packageName] ?? a.pcInstallAt,
          })),
        }));
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[ui] refresh error', e);
      setLoading(false);
    }
  }, [currentDeviceId, setApps, setLoading, message, loadMetaSequential, loadDetailsBackground]);

  // 防止 StrictMode 或父组件重复触发：同一设备 ID 只 refresh 一次
  const lastRefreshedDeviceRef = useRef<string | null>(null);
  useEffect(() => {
    if (currentDeviceId && lastRefreshedDeviceRef.current === currentDeviceId) {
      return;
    }
    lastRefreshedDeviceRef.current = currentDeviceId;
    refresh();
  }, [refresh, currentDeviceId]);

  // 当数据出现/变化时，强制重新测量表格高度（应对 enrich 后内容变化导致的容器尺寸变化）
  useEffect(() => {
    const raf = requestAnimationFrame(computeTableHeight);
    return () => cancelAnimationFrame(raf);
  }, [apps.length, computeTableHeight]);

  // 搜索过滤
  // 先按 category 分流，再按关键字过滤
  /** 综合活跃度评分：设备启动次数 0.6 + PC 交互 ×8×0.4 */
  const calcScore = (a: AppInfo) =>
    (a.deviceUseCount ?? 0) * 0.6 + (a.pcInteractCount ?? 0) * 8 * 0.4;

  const filtered = useMemo(() => {
    let arr = apps;
    if (category === 'user') arr = arr.filter((a) => !a.isSystem);
    else if (category === 'system') arr = arr.filter((a) => a.isSystem);

    if (keyword.trim()) {
      const k = keyword.toLowerCase();
      arr = arr.filter(
        (a) =>
          a.packageName.toLowerCase().includes(k) ||
          (a.appName && a.appName.toLowerCase().includes(k))
      );
    }
    // 排序优先级：
    // 1) 本次 PC 上安装过的（pcInstallAt 有值）按安装时间倒序（最新装的最靠前）
    // 2) 其它应用按使用频率综合评分倒序
    // 3) 评分相同按名称
    return [...arr].sort((a, b) => {
      const ta = a.pcInstallAt ?? 0;
      const tb = b.pcInstallAt ?? 0;
      if (ta !== tb) return tb - ta;   // 有装机时间的天然排前，且新装的在前
      const sb = calcScore(b);
      const sa = calcScore(a);
      if (sb !== sa) return sb - sa;
      return (a.appName ?? a.packageName).localeCompare(b.appName ?? b.packageName);
    });
  }, [apps, keyword, category]);

  // 安装 APK
  const onInstall = async () => {
    if (!currentDeviceId) {
      message.warning('请先连接设备');
      return;
    }
    const r = await window.api.pickApks();
    if (!r.ok || !r.data?.length) return;

    // 立即插入任务面板（installing 0%），进度由全局 onInstallProgress 更新
    const ts = useTaskStore.getState();
    for (const p of r.data) {
      ts.upsertTask({ apk: p, status: 'installing', percent: 0, stage: 'starting' });
    }

    // 触发安装但不阻塞 UI；等全部完成后刷新列表
    window.api.installApks(currentDeviceId, r.data).then((res) => {
      if (res.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const failed = (res.data as any[]).filter((x) => !x.ok);
        if (failed.length > 0) {
          message.warning({
            content: `${failed.length} 个 APK 安装失败，详情请查看右下角任务面板`,
            duration: 6,
          });
          useTaskStore.getState().setPanelOpen(true);
        }
        refresh();
      } else {
        message.error({
          content: `安装失败：${res.error}（详情请查看右下角任务面板）`,
          duration: 6,
        });
        useTaskStore.getState().setPanelOpen(true);
      }
    });
  };

  // 卸载
  const onUninstall = async (pkg: string) => {
    if (!currentDeviceId) return;
    const r = await window.api.uninstallApp(currentDeviceId, pkg);
    if (r.ok) {
      message.success(`已卸载：${pkg}`);
      refresh();
    } else {
      message.error(`卸载失败：${r.error}`);
    }
  };

  // 批量卸载
  const onBatchUninstall = async () => {
    if (!currentDeviceId || selectedKeys.length === 0) return;
    for (const k of selectedKeys) {
      await window.api.uninstallApp(currentDeviceId, String(k));
    }
    message.success(`已卸载 ${selectedKeys.length} 个`);
    setSelectedKeys([]);
    refresh();
  };

  // 导出 APK
  const onExport = async (pkg: string) => {
    if (!currentDeviceId) return;
    const dir = await window.api.pickDirectory();
    if (!dir.ok || !dir.data) return;
    message.loading({ content: '导出中…', key: 'export' });
    const r = await window.api.exportApk(currentDeviceId, pkg, dir.data);
    if (r.ok) {
      message.success({ content: `导出成功：${r.data}`, key: 'export' });
    } else {
      message.error({ content: `导出失败：${r.error}`, key: 'export' });
    }
  };

  // 创建引擎热更目录（仅 com.tencent.uc 适用）
  // 在应用文档目录 /sdcard/Android/data/<pkg>/ 下创建 ExtraFiles/arm64-v8a
  const onCreateEngineHotUpdateDir = async (pkg: string) => {
    if (!currentDeviceId) {
      message.warning('请先连接设备');
      return;
    }
    const target = `/sdcard/Android/data/${pkg}/files/ExtraFiles/arm64-v8a`;
    message.loading({ content: '创建中…', key: 'mkEngineDir' });
    const r = await window.api.fsMkdir(currentDeviceId, target);
    if (r.ok) {
      message.success({
        content: `已创建：${target}`,
        key: 'mkEngineDir',
        duration: 3,
      });
    } else {
      message.error({
        content: `创建失败：${r.error}`,
        key: 'mkEngineDir',
        duration: 4,
      });
    }
  };

  // 右键菜单状态
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    record: AppInfo | null;
  }>({ x: 0, y: 0, record: null });

  // 构造右键菜单项（按当前 record 动态生成）
  const ctxMenuItems = useMemo<MenuProps['items']>(() => {
    const r = ctxMenu.record;
    if (!r) return [];
    const items: MenuProps['items'] = [];
    if (r.packageName === 'com.tencent.uc') {
      items.push({
        key: 'create-engine-hot-update-dir',
        label: '创建引擎热更目录',
      });
    }
    return items;
  }, [ctxMenu.record]);

  const onCtxMenuClick: MenuProps['onClick'] = ({ key }) => {
    const r = ctxMenu.record;
    if (!r) return;
    if (key === 'create-engine-hot-update-dir') {
      onCreateEngineHotUpdateDir(r.packageName);
    }
    setCtxMenu({ x: 0, y: 0, record: null });
  };

  // 右键菜单打开时：监听全局事件以"自动关闭"
  // 由于 Dropdown 使用 trigger={[]} 受控模式，antd 不会自己监听外部点击，需要我们补齐：
  // - 任意 mousedown（除菜单自身）→ 关
  // - 右键到别处 → 关（onContextMenu 里若命中其他可右键行会立刻重开新菜单）
  // - Esc → 关
  // - 滚动 / 窗口尺寸变化 → 关（避免菜单悬浮在错误位置）
  // - 窗口失焦 → 关
  useEffect(() => {
    if (!ctxMenu.record) return;

    const closeMenu = () => setCtxMenu({ x: 0, y: 0, record: null });

    const isInsideDropdown = (target: EventTarget | null): boolean => {
      if (!(target instanceof Node)) return false;
      // antd 把 dropdown 渲染到 body 下的 .ant-dropdown 容器内
      const el = target as Element;
      const dropdownEl = (el.nodeType === 1 ? el : el.parentElement)?.closest?.('.ant-dropdown');
      return !!dropdownEl;
    };

    const onMouseDown = (e: MouseEvent) => {
      if (isInsideDropdown(e.target)) return;
      closeMenu();
    };
    const onGlobalContextMenu = (e: MouseEvent) => {
      // 让原生右键事件先冒泡到行上去（行 onContextMenu 会更新 ctxMenu），
      // 这里仅当目标不在 dropdown 内时关闭旧菜单；新菜单（若有）会在下一次 setState 里被打开。
      if (isInsideDropdown(e.target)) return;
      closeMenu();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    const onScroll = () => closeMenu();
    const onResize = () => closeMenu();
    const onBlur = () => closeMenu();

    // 用 setTimeout 推迟一帧绑定 mousedown，避免捕获到"触发右键时同步派发的鼠标按下事件"导致刚开就被关
    const timer = window.setTimeout(() => {
      window.addEventListener('mousedown', onMouseDown, true);
    }, 0);
    window.addEventListener('contextmenu', onGlobalContextMenu, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true); // capture 以覆盖任意内部滚动容器
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', onBlur);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('contextmenu', onGlobalContextMenu, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('blur', onBlur);
    };
  }, [ctxMenu.record]);


  // 各分类计数（用于 Tab 上的徽标）
  const counts = useMemo(() => {
    return {
      all: apps.length,
      user: apps.filter((a) => !a.isSystem).length,
      system: apps.filter((a) => a.isSystem).length,
    };
  }, [apps]);

  const columns: ColumnsType<AppInfo> = [
    {
      title: '名称',
      dataIndex: 'packageName',
      key: 'name',
      sorter: (a, b) =>
        (a.appName || a.packageName).localeCompare(b.appName || b.packageName),
      render: (_v, r) => {
        const name = r.appName || fallbackAppName(r.packageName);
        return (
          <div className="app-cell">
            <div className="app-icon">
              {r.iconBase64
                ? <img src={`data:image/png;base64,${r.iconBase64}`} alt="" />
                : pkgInitial(r.packageName)}
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="app-name-main">{name}</div>
              <div className="app-name-sub">{r.packageName}</div>
            </div>
          </div>
        );
      },
    },
    {
      title: '类型',
      dataIndex: 'isSystem',
      key: 'type',
      width: 100,
      render: (v: boolean) =>
        v
          ? <span className="type-tag system">系统</span>
          : <span className="type-tag user">用户</span>,
    },
    {
      title: '版本',
      dataIndex: 'versionName',
      key: 'version',
      width: 130,
      sorter: (a, b) => (a.versionName || '').localeCompare(b.versionName || ''),
      render: (v) => v || <span style={{ color: '#bfbfbf' }}>读取中</span>,
    },
    {
      title: '应用大小',
      dataIndex: 'apkSize',
      key: 'apkSize',
      width: 110,
      sorter: (a, b) => (a.apkSize ?? 0) - (b.apkSize ?? 0),
      render: (v: number | undefined) =>
        v == null
          ? <span style={{ color: '#bfbfbf' }}>读取中</span>
          : fmtSize(v),
    },
    {
      title: '文档大小',
      dataIndex: 'dataSize',
      key: 'dataSize',
      width: 110,
      sorter: (a, b) => (a.dataSize ?? 0) - (b.dataSize ?? 0),
      render: (v: number | undefined) =>
        v == null
          ? <span style={{ color: '#bfbfbf' }}>—</span>
          : fmtSize(v),
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      align: 'right',
      fixed: 'right',
      render: (_v, r) => (
        <>
          <span
            className="row-btn"
            onClick={() => setBrowserTarget(r)}
          >
            浏览
          </span>
          <Popconfirm
            title={`确认卸载 ${r.appName || r.packageName} ?`}
            onConfirm={() => onUninstall(r.packageName)}
            disabled={r.isSystem}
          >
            <span className={`row-btn danger ${r.isSystem ? 'disabled' : ''}`}>
              卸载
            </span>
          </Popconfirm>
        </>
      ),
    },
  ];

  if (!currentDeviceId) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Empty description="请先连接安卓设备" />
      </div>
    );
  }

  return (
    <>
      {/* 顶部页头：应用 + 类别 Tab */}
      <div className="apps-page-header">
        <div className="page-title">应用</div>
        <div
          className={`cat-tab ${category === 'all' ? 'active' : ''}`}
          onClick={() => setCategory('all')}
        >
          全部 <span className="cat-count">{counts.all}</span>
        </div>
        <div
          className={`cat-tab ${category === 'user' ? 'active' : ''}`}
          onClick={() => setCategory('user')}
        >
          用户 <span className="cat-count">{counts.user}</span>
        </div>
        <div
          className={`cat-tab ${category === 'system' ? 'active' : ''}`}
          onClick={() => setCategory('system')}
        >
          系统 <span className="cat-count">{counts.system}</span>
        </div>

        <div style={{ flex: 1 }} />

        <Input
          allowClear
          prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
          placeholder="搜索"
          style={{ width: 220, borderRadius: 16 }}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
      </div>

      {/* 工具栏：导入安装 / 卸载 / 刷新 */}
      <div className="toolbar">
        <span className="tb-btn" onClick={onInstall}>
          <ImportOutlined /> 导入安装
        </span>

        {selectedKeys.length > 0 ? (
          <Popconfirm
            title={`确认卸载选中的 ${selectedKeys.length} 个应用？`}
            onConfirm={onBatchUninstall}
          >
            <span className="tb-btn">
              <DeleteOutlined /> 卸载 ({selectedKeys.length})
            </span>
          </Popconfirm>
        ) : (
          <span className="tb-btn disabled">
            <DeleteOutlined /> 卸载
          </span>
        )}

        <span className="tb-btn" onClick={refresh}>
          <ReloadOutlined /> 刷新
        </span>
      </div>

      {/* 表格：外层 ref 测量高度，传给 Ant Table scroll.y 实现内部滚动 */}
      <div className="apps-table-wrap" ref={tableWrapRef}>
        <Table<AppInfo>
          className="apps-table"
          rowKey="packageName"
          loading={loading}
          dataSource={filtered}
          columns={columns}
          size="middle"
          pagination={false}
          rowSelection={{
            selectedRowKeys: selectedKeys,
            onChange: setSelectedKeys,
            columnWidth: 48,
          }}
          scroll={tableBodyHeight > 0 ? { y: tableBodyHeight } : undefined}
          onRow={(record) => ({
            onContextMenu: (e) => {
              // 仅在该行存在右键菜单项时拦截
              if (record.packageName !== 'com.tencent.uc') return;
              e.preventDefault();
              setCtxMenu({ x: e.clientX, y: e.clientY, record });
            },
          })}
        />
      </div>

      {/* 行右键菜单：通过受控 Dropdown + fixed 定位锚点实现 */}
      <Dropdown
        menu={{ items: ctxMenuItems, onClick: onCtxMenuClick }}
        open={!!ctxMenu.record && (ctxMenuItems?.length ?? 0) > 0}
        onOpenChange={(open) => {
          if (!open) setCtxMenu({ x: 0, y: 0, record: null });
        }}
        trigger={[]}
      >
        <div
          style={{
            position: 'fixed',
            left: ctxMenu.x,
            top: ctxMenu.y,
            width: 1,
            height: 1,
            pointerEvents: 'none',
          }}
        />
      </Dropdown>


      {/* 文件浏览器抽屉：始终渲染，用 open 控制；关闭时通过 afterOpenChange 清 target */}
      <FileBrowserDrawer
        open={!!browserTarget}
        onClose={() => setBrowserTarget(null)}
        deviceId={currentDeviceId ?? ''}
        title={
          browserTarget
            ? `${browserTarget.appName || browserTarget.packageName} · 文档目录`
            : ''
        }
        initialPath={
          browserTarget
            ? `/sdcard/Android/data/${browserTarget.packageName}`
            : '/sdcard/'
        }
      />
    </>
  );
}
