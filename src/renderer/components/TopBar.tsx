import {
  MinusOutlined, BorderOutlined, CloseOutlined,
} from '@ant-design/icons';
import logoUrl from '../assets/logo.png';

export default function TopBar() {
  return (
    <div className="app-topbar">
      <div className="logo">
        <div className="logo-icon">
          <img src={logoUrl} alt="" />
        </div>
        手机助手
      </div>

      {/* 中间留空（保留拖拽区域） */}
      <div className="nav-tabs-placeholder" />

      <div className="topbar-right">
        <div
          className="topbar-icon"
          title="最小化"
          onClick={() => window.api.winMinimize()}
        >
          <MinusOutlined />
        </div>
        <div
          className="topbar-icon"
          title="最大化"
          onClick={() => window.api.winMaximize()}
        >
          <BorderOutlined />
        </div>
        <div
          className="topbar-icon close"
          title="关闭"
          onClick={() => window.api.winClose()}
        >
          <CloseOutlined />
        </div>
      </div>
    </div>
  );
}
