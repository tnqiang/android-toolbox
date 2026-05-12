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
  // 截图位图本身是否横向（naturalWidth > naturalHeight），由 img onLoad 探测
  const [imgIsLandscape, setImgIsLandscape] = useState<boolean | null>(null);
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
        setImgIsLandscape(null);
      } else if (!r.ok) message.error(`截屏失败：${r.error}`);
    } finally {
      setShotLoading(false);
    }
  }, [currentDeviceId, message]);

  // 保存截图到本地
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

  // 复制截图到剪贴板（PNG）
  const copyScreenshot = useCallback(async () => {
    if (!screenshot) {
      message.warning('暂无截图可复制');
      return;
    }
    try {
      // base64 → Blob → ClipboardItem
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

  // 切换设备时清掉旧截屏，重新加载
  useEffect(() => {
    setScreenshot(null);
    setImgIsLandscape(null);
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
  const displayName =
    `${detail.brand ? detail.brand.charAt(0).toUpperCase() + detail.brand.slice(1) : ''} ${detail.model ?? ''}`.trim();

  return (
    <div className="device-info-page">
      {/* 顶部概览条 */}
      <div className="di-header">
        <div className="di-header-left">
          <div className="di-device-name">{displayName || detail.deviceId}</div>
          <div className="di-device-sub">
            Android {detail.androidVersion ?? '?'} · SDK {detail.sdkVersion ?? '?'} · {detail.serialno}
          </div>
        </div>
        <div className="di-header-right">
          {fmtBytes(storage.totalBytes)}
          <span className="di-battery">
            <ThunderboltOutlined style={{ color: battery.isCharging ? '#52c41a' : '#faad14' }} />
            {battery.level ?? '?'}%
          </span>
          <Button icon={<SyncOutlined />} size="small" onClick={load} loading={loading}>刷新</Button>
        </div>
      </div>

      <div className="di-body">
        {/* 左侧：设备示意图 + 重启/关机 */}
        <div className="di-left">
          {(() => {
            // UI 上 mock 始终保持竖向 180x320
            const mockW = 180;
            const mockH = 320;
            // 当图片本身是横向时，旋转 -90° 让其在竖向 mock 内呈现
            const needRotate = screenshot != null && imgIsLandscape === true;
            const menuItems = [
              {
                key: 'save',
                icon: <SaveOutlined />,
                label: '保存截图到本地…',
                disabled: !screenshot,
                onClick: saveScreenshot,
              },
              {
                key: 'copy',
                icon: <CopyOutlined />,
                label: '复制到剪贴板',
                disabled: !screenshot,
                onClick: copyScreenshot,
              },
              { type: 'divider' as const },
              {
                key: 'refresh',
                icon: <CameraOutlined />,
                label: '重新截屏',
                onClick: refreshScreenshot,
              },
            ];
            return (
              <Dropdown menu={{ items: menuItems }} trigger={['contextMenu']}>
                <div
                  className="di-phone-mock"
                  style={{ width: mockW, height: mockH }}
                >
                  {screenshot ? (
                    <img
                      src={`data:image/png;base64,${screenshot}`}
                      alt="device screen"
                      className="di-phone-screen"
                      onLoad={(e) => {
                        const img = e.currentTarget;
                        setImgIsLandscape(img.naturalWidth > img.naturalHeight);
                      }}
                      style={
                        needRotate
                          ? {
                              // 旋转前的 layout 宽高 = 容器的"高 × 宽"
                              // 旋转 -90° 后视觉占满 180x320 容器
                              width: mockH,
                              height: mockW,
                              position: 'absolute',
                              top: '50%',
                              left: '50%',
                              transformOrigin: 'center center',
                              transform: 'translate(-50%, -50%) rotate(-90deg)',
                            }
                          : undefined
                      }
                    />
                  ) : shotLoading ? (
                    <Spin />
                  ) : (
                    <>
                      <MobileOutlined />
                      <div className="di-phone-label">{detail.model ?? detail.deviceId}</div>
                    </>
                  )}
                </div>
              </Dropdown>
            );
          })()}
          <div className="di-actions">
            <Button
              icon={<CameraOutlined />}
              onClick={refreshScreenshot}
              loading={shotLoading}
            >
              截屏
            </Button>
            <Popconfirm title="确认重启设备？" onConfirm={onReboot}>
              <Button icon={<ReloadOutlined />}>重启</Button>
            </Popconfirm>
            <Popconfirm title="确认关机？" onConfirm={onPowerOff}>
              <Button icon={<PoweroffOutlined />}>关机</Button>
            </Popconfirm>
            <Button icon={<SyncOutlined />} onClick={load}>刷新</Button>
          </div>
        </div>

        {/* 中间：设备详情 */}
        <div className="di-card di-details-card">
          <InfoRow label="Android 版本" value={`${detail.androidVersion ?? '-'} (SDK ${detail.sdkVersion ?? '-'})`} />
          <InfoRow label="安全补丁" value={detail.securityPatch} />
          <InfoRow label="序列号" value={detail.serialno} />
          <InfoRow label="品牌 / 厂商" value={`${detail.brand ?? '-'} / ${detail.manufacturer ?? '-'}`} />
          <InfoRow label="型号" value={detail.model} />
          <InfoRow label="内部代号" value={detail.product} />
          <InfoRow label="CPU 架构" value={detail.cpuAbi} />
          <InfoRow label="CPU 硬件" value={
            [detail.cpuHardware, detail.socModel].filter(Boolean).join(' / ') || undefined
          } />
          <InfoRow label="内存" value={
            detail.memory?.totalBytes != null
              ? `${fmtBytes(detail.memory.totalBytes)}${
                  detail.memory.availableBytes != null
                    ? `（可用 ${fmtBytes(detail.memory.availableBytes)}）`
                    : ''
                }`
              : undefined
          } />
          <InfoRow label="屏幕" value={
            detail.screenResolution
              ? `${detail.screenResolution}${detail.screenDensity ? ` @ ${detail.screenDensity} dpi` : ''}`
              : undefined
          } />
          <InfoRow label="Bootloader" value={detail.bootloader} />
          <InfoRow label="Root 状态"
            value={
              detail.rootStatus === 'rooted'
                ? '已 Root'
                : detail.rootStatus === 'not-rooted' ? '未 Root' : '未知'
            }
          />
          <InfoRow label="地区" value={detail.region} />
          <InfoRow label="构建版本" value={detail.buildNumber} />
          <InfoRow label="构建日期" value={detail.buildDate} />
        </div>

        {/* 右侧：电池 + 存储 */}
        <div className="di-right">
          <div className="di-card di-battery-card">
            <div className="di-card-title">电池</div>
            <div className="di-ring">
              <Progress
                type="circle"
                percent={battery.level ?? 0}
                size={100}
                strokeColor={battery.isCharging ? '#52c41a' : '#1677ff'}
              />
            </div>
            <InfoRow label="状态" value={battery.status} />
            <InfoRow label="健康" value={battery.health} />
            <InfoRow label="温度" value={battery.temperature != null ? `${battery.temperature.toFixed(1)}°C` : undefined} />
          </div>

          <div className="di-card di-storage-card">
            <div className="di-card-title">存储 (/data)</div>
            <div className="di-ring">
              <Progress
                type="circle"
                percent={storagePercent}
                size={100}
                strokeColor="#faad14"
              />
            </div>
            <InfoRow label="总容量" value={fmtBytes(storage.totalBytes)} />
            <InfoRow label="已使用" value={fmtBytes(storage.usedBytes)} />
            <InfoRow label="剩余" value={fmtBytes(storage.availableBytes)} />
          </div>
        </div>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value?: string | number }) {
  return (
    <div className="di-row">
      <span className="di-row-label">{label}</span>
      <span className="di-row-value">{value ?? '-'}</span>
    </div>
  );
}
