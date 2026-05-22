import { useCallback, useEffect, useState } from 'react';
import { App as AntdApp, Button, Dropdown, Empty, Popconfirm, Progress, Spin } from 'antd';
import {
  PoweroffOutlined, ReloadOutlined, SyncOutlined, MobileOutlined,
  ThunderboltOutlined, CameraOutlined, SaveOutlined, CopyOutlined,
} from '@ant-design/icons';
import { useAppStore } from '../store/useAppStore';

interface DeviceDetail {
  deviceId: string;
  brand?: string;
  manufacturer?: string;
  model?: string;
  product?: string;
  serialno?: string;
  androidVersion?: string;
  sdkVersion?: string;
  buildNumber?: string;
  buildDate?: string;
  securityPatch?: string;
  cpuAbi?: string;
  cpuHardware?: string;
  socManufacturer?: string;
  socModel?: string;
  screenResolution?: string;
  screenDensity?: string;
  macAddress?: string;
  kernelVersion?: string;
  bootloader?: string;
  rootStatus?: 'rooted' | 'not-rooted' | 'unknown';
  region?: string;
  battery?: {
    level?: number;
    status?: string;
    health?: string;
    temperature?: number;
    voltage?: number;
    technology?: string;
    isCharging?: boolean;
  };
  storage?: {
    totalBytes?: number;
    usedBytes?: number;
    availableBytes?: number;
  };
  memory?: {
    totalBytes?: number;
    availableBytes?: number;
    usedBytes?: number;
  };
}

function fmtBytes(n?: number): string {
  if (n == null) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export default function DeviceInfoPage() {
  const currentDeviceId = useAppStore((s) => s.currentDeviceId);
  const [detail, setDetail] = useState<DeviceDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [shotLoading, setShotLoading] = useState(false);
  const { message } = AntdApp.useApp();

  const load = useCallback(async () => {
    if (!currentDeviceId) {
      setDetail(null);
      return;
    }
    setLoading(true);
    try {
      const r = await window.api.getDeviceDetailInfo(currentDeviceId);
      if (r.ok) setDetail(r.data as DeviceDetail);
      else message.error(`读取设备信息失败：${r.error}`);
    } finally {
      setLoading(false);
    }
  }, [currentDeviceId, message]);

  const refreshScreenshot = useCallback(async () => {
    if (!currentDeviceId) return;
    setShotLoading(true);
    try {
      const r = await window.api.takeScreenshot(currentDeviceId);
      if (r.ok && r.data) {
        setScreenshot(r.data.image);
        setImgSize(null);
      } else if (!r.ok) message.error(`截屏失败：${r.error}`);
    } finally {
      setShotLoading(false);
    }
  }, [currentDeviceId, message]);

  const saveScreenshot = useCallback(async () => {
    if (!screenshot) {
      message.warning('暂无截图可保存');
      return;
    }
    const ts = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
    const namePart = currentDeviceId ? currentDeviceId.replace(/[^\w.-]+/g, '_') : 'device';
    const suggested = `screenshot_${namePart}_${stamp}.png`;
    const r = await window.api.saveScreenshot(screenshot, suggested);
    if (r.ok && r.data) message.success(`已保存到：${r.data}`);
    else if (r.error && r.error !== 'canceled') message.error(`保存失败：${r.error}`);
  }, [screenshot, currentDeviceId, message]);

  const copyScreenshot = useCallback(async () => {
    if (!screenshot) {
      message.warning('暂无截图可复制');
      return;
    }
    try {
      const bin = atob(screenshot);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const blob = new Blob([arr], { type: 'image/png' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ClipboardItemCtor = (window as any).ClipboardItem;
      if (!ClipboardItemCtor || !navigator.clipboard?.write) {
        message.error('当前环境不支持图片复制到剪贴板');
        return;
      }
      await navigator.clipboard.write([new ClipboardItemCtor({ 'image/png': blob })]);
      message.success('已复制到剪贴板');
    } catch (err) {
      message.error(`复制失败：${(err as Error).message}`);
    }
  }, [screenshot, message]);

  useEffect(() => {
    setScreenshot(null);
    setImgSize(null);
    load();
    refreshScreenshot();
  }, [load, refreshScreenshot]);

  const onReboot = async () => {
    if (!currentDeviceId) return;
    const r = await window.api.rebootDevice(currentDeviceId);
    if (r.ok) message.success('已发送重启指令');
    else message.error(`重启失败：${r.error}`);
  };

  const onPowerOff = async () => {
    if (!currentDeviceId) return;
    const r = await window.api.powerOffDevice(currentDeviceId);
    if (r.ok) message.success('已发送关机指令');
    else message.error(`关机失败：${r.error}`);
  };

  // —— 健康检查/底部磁贴已按需求移除 ——

  if (!currentDeviceId) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Empty description="请先连接安卓设备" />
      </div>
    );
  }
  if (loading && !detail) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin />
      </div>
    );
  }
  if (!detail) return null;

  const battery = detail.battery ?? {};
  const storage = detail.storage ?? {};
  const storagePercent = storage.totalBytes && storage.usedBytes
    ? Math.round((storage.usedBytes / storage.totalBytes) * 100)
    : 0;
  // 注意：截图里的"电池寿命百分比"是健康度（FCC/Design），ADB 拿到的 `health` 是字符串
  // （Good/Overheat/...），没有数值。这里我们用电量当前百分比作为环形展示，避免误导。
  const batteryPercent = Math.max(0, Math.min(100, battery.level ?? 0));

  // 屏幕预览右键菜单
  const screenMenu = [
    { key: 'save', icon: <SaveOutlined />, label: '保存截图到本地…', disabled: !screenshot, onClick: saveScreenshot },
    { key: 'copy', icon: <CopyOutlined />, label: '复制到剪贴板', disabled: !screenshot, onClick: copyScreenshot },
    { type: 'divider' as const },
    { key: 'refresh', icon: <CameraOutlined />, label: '重新截屏', onClick: refreshScreenshot },
  ];

  // mock 容器尺寸：
  //  - 没有截图时给一个固定竖屏占位（200×356，≈ 9:16）
  //  - 有截图时按真实宽高比自适应，限制在 240×420 的方框内等比缩放，
  //    避免横屏截图在固定竖框里上下留黑
  const MAX_W = 240;
  const MAX_H = 420;
  let mockW = 200;
  let mockH = 356;
  if (screenshot && imgSize) {
    const ratio = imgSize.w / imgSize.h;
    // 优先按高度铺满
    let h = MAX_H;
    let w = h * ratio;
    if (w > MAX_W) {
      w = MAX_W;
      h = w / ratio;
    }
    mockW = Math.round(w);
    mockH = Math.round(h);
  }

  return (
    <div className="device-info-page">
      {/* ============ 顶部操作条（电量 + 刷新） ============ */}
      <div className="di-toolbar">
        <span className={`di-battery-pill ${battery.isCharging ? 'is-charging' : ''}`}>
          <ThunderboltOutlined />
          <span className="di-battery-pill-text">
            {battery.isCharging ? '充电中' : '使用中'}
          </span>
          <span className="di-battery-pill-level">{battery.level ?? '?'}%</span>
        </span>
        <Button icon={<SyncOutlined />} onClick={load} loading={loading}>刷新</Button>
      </div>

      {/* ============ 主体三列 ============ */}
      <div className="di-body">
        {/* —— 左：手机 mock + 操作按钮 —— */}
        <div className="di-col-left">
          <Dropdown menu={{ items: screenMenu }} trigger={['contextMenu']}>
            <div className="di-phone-mock" style={{ width: mockW, height: mockH }}>
              {screenshot ? (
                <img
                  src={`data:image/png;base64,${screenshot}`}
                  alt="device screen"
                  className="di-phone-screen"
                  onLoad={(e) => {
                    const img = e.currentTarget;
                    setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
                  }}
                />
              ) : shotLoading ? (
                <Spin />
              ) : (
                <div className="di-phone-placeholder">
                  <MobileOutlined />
                  <div className="di-phone-label">{detail.model ?? detail.deviceId}</div>
                </div>
              )}
            </div>
          </Dropdown>

          <div className="di-circle-actions">
            <Popconfirm title="确认重启设备？" onConfirm={onReboot}>
              <button className="di-circle-btn" type="button">
                <ReloadOutlined />
                <span>重启</span>
              </button>
            </Popconfirm>
            <Popconfirm title="确认关机？" onConfirm={onPowerOff}>
              <button className="di-circle-btn" type="button">
                <PoweroffOutlined />
                <span>关机</span>
              </button>
            </Popconfirm>
            <button
              className="di-circle-btn"
              type="button"
              onClick={refreshScreenshot}
              disabled={shotLoading}
            >
              <CameraOutlined />
              <span>截屏</span>
            </button>
          </div>

          {/* 状态卡：电量 / 存储（移到截屏下方，与左列对齐） */}
          <div className="di-stats">
            <div className="di-card di-stat-card">
              <div className="di-stat-text">
                <div className="di-stat-title">
                  电量 {battery.level ?? '-'}%
                </div>
                <div className="di-stat-sub">
                  {battery.isCharging ? '充电中' : '未充电'}
                  {battery.health ? ` · 健康 ${battery.health}` : ''}
                </div>
              </div>
              <div className="di-stat-ring">
                <Progress
                  type="circle"
                  percent={batteryPercent}
                  size={64}
                  strokeWidth={10}
                  strokeColor={battery.isCharging ? '#22c55e' : '#16a34a'}
                  trailColor="#e7f6ec"
                  format={(p) => <span className="di-ring-text">{p}%</span>}
                />
              </div>
            </div>

            <div className="di-card di-stat-card">
              <div className="di-stat-text">
                <div className="di-stat-title">
                  存储 {fmtBytes(storage.totalBytes)}
                </div>
                <div className="di-stat-sub">
                  可用 {fmtBytes(storage.availableBytes)}
                </div>
              </div>
              <div className="di-stat-ring">
                <Progress
                  type="circle"
                  percent={storagePercent}
                  size={64}
                  strokeWidth={10}
                  strokeColor="#f59e0b"
                  trailColor="#fff4e0"
                  format={(p) => <span className="di-ring-text">{p}%</span>}
                />
              </div>
            </div>
          </div>
        </div>

        {/* —— 右：详情卡片 —— */}
        <div className="di-card di-details-card">
          <DetailRow label="系统版本" value={
            detail.androidVersion
              ? `Android ${detail.androidVersion}${detail.sdkVersion ? ` (API ${detail.sdkVersion})` : ''}`
              : undefined
          } />
          <DetailRow label="序列号" value={detail.serialno} mono />
          <DetailRow label="设备 ID" value={detail.deviceId} mono />
          <DetailRow label="品牌 / 厂商" value={
            [detail.brand, detail.manufacturer].filter(Boolean).join(' / ') || undefined
          } />
          <DetailRow label="型号" value={detail.model} />
          <DetailRow label="内部代号" value={detail.product} />
          <DetailRow label="CPU 架构" value={detail.cpuAbi} />
          <DetailRow label="CPU / SoC" value={
            [detail.cpuHardware, detail.socModel].filter(Boolean).join(' · ') || undefined
          } />
          <DetailRow label="屏幕" value={
            detail.screenResolution
              ? `${detail.screenResolution}${detail.screenDensity ? ` @ ${detail.screenDensity} dpi` : ''}`
              : undefined
          } />
          <DetailRow label="安全补丁" value={detail.securityPatch} />
          <DetailRow label="构建版本" value={detail.buildNumber} mono />
          <DetailRow label="Bootloader" value={detail.bootloader} mono />
          <DetailRow label="Root 状态" value={
            detail.rootStatus === 'rooted'
              ? '已 Root'
              : detail.rootStatus === 'not-rooted' ? '未 Root' : '未知'
          } />
          <DetailRow label="地区" value={detail.region} />
          <DetailRow label="构建日期" value={detail.buildDate} />
        </div>
      </div>
    </div>
  );
}

/** 详情卡片中的一行键值 */
function DetailRow({ label, value, mono }: { label: string; value?: string | number; mono?: boolean }) {
  return (
    <div className="di-detail-row">
      <span className="di-detail-label">{label}</span>
      <span className={`di-detail-value${mono ? ' is-mono' : ''}`}>{value ?? '-'}</span>
    </div>
  );
}
