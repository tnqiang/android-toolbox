import { Empty, Select } from 'antd';
import {
  AppstoreOutlined, InfoCircleOutlined,
} from '@ant-design/icons';
import { useAppStore } from '../store/useAppStore';

interface Props {
  section: string;
  onSectionChange: (s: string) => void;
}

const MENU = [
  { key: 'info',     label: '设备信息', icon: <InfoCircleOutlined /> },
  { key: 'apps',     label: '应用',     icon: <AppstoreOutlined /> },
];

export default function Sidebar({ section, onSectionChange }: Props) {
  const devices = useAppStore((s) => s.devices);
  const currentDeviceId = useAppStore((s) => s.currentDeviceId);
  const setCurrentDevice = useAppStore((s) => s.setCurrentDevice);
  const apps = useAppStore((s) => s.apps);

  const onlineDevices = devices.filter((d) => d.state === 'device');
  const current = onlineDevices.find((d) => d.id === currentDeviceId);

  return (
    <div className="app-sidebar">
      {onlineDevices.length === 0 ? (
        <div className="device-card">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="未检测到设备"
            style={{ marginTop: 8 }}
          />
          <div style={{ fontSize: 12, color: '#bfbfbf', textAlign: 'center', marginTop: 8 }}>
            请通过 USB 连接安卓设备<br />并打开「USB 调试」
          </div>
        </div>
      ) : (
        <div className="device-card">
          <div className="device-name">
            {current?.brand ?? ''} {current?.model ?? current?.id}
          </div>
          <div className="device-sub">
            Android {current?.androidVersion ?? '?'} · {current?.id.slice(0, 14)}
          </div>
          {onlineDevices.length > 1 && (
            <Select
              size="small"
              style={{ marginTop: 8, width: '100%' }}
              value={currentDeviceId ?? undefined}
              options={onlineDevices.map((d) => ({
                value: d.id,
                label: `${d.brand ?? ''} ${d.model ?? d.id}`,
              }))}
              onChange={setCurrentDevice}
            />
          )}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', paddingTop: 6 }}>
        {MENU.map((m) => (
          <div
            key={m.key}
            className={`side-menu-item ${section === m.key ? 'active' : ''}`}
            onClick={() => onSectionChange(m.key)}
          >
            {m.icon} {m.label}
            {m.key === 'apps' && apps.length > 0 && (
              <span className="badge">{apps.length}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
