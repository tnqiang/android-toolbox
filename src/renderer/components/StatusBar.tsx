import { version } from '../../../package.json';

export default function StatusBar() {
  return (
    <div className="statusbar">
      <div className="sb-right">
        <span>V{version}</span>
      </div>
    </div>
  );
}
