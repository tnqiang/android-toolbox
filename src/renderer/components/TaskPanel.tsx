import { Progress, Button, Empty } from 'antd';
import {
  CloseOutlined, CheckCircleFilled, CloseCircleFilled,
  DownOutlined, UpOutlined, DeleteOutlined,
} from '@ant-design/icons';
import { useTaskStore, type InstallTask } from '../store/useTaskStore';

function stageLabel(stage: string): string {
  switch (stage) {
    case 'starting': return '准备中';
    case 'pushing': return '传输中';
    case 'installing': return '安装中';
    case 'done': return '已完成';
    case 'failed': return '失败';
    default: return stage;
  }
}

function TaskRow({ task }: { task: InstallTask }) {
  return (
    <div className="task-row">
      <div className="task-row-top">
        <span className="task-name" title={task.apk}>{task.apkName}</span>
        <span className="task-stage">
          {task.status === 'success' && <CheckCircleFilled style={{ color: '#52c41a' }} />}
          {task.status === 'failed' && <CloseCircleFilled style={{ color: '#ff4d4f' }} />}
          {task.status === 'installing' && stageLabel(task.stage)}
          {task.status === 'success' && ' 成功'}
          {task.status === 'failed' && ' 失败'}
        </span>
      </div>
      <Progress
        percent={task.percent}
        size="small"
        status={
          task.status === 'failed' ? 'exception' :
            task.status === 'success' ? 'success' : 'active'
        }
        showInfo={task.status === 'installing'}
      />
      {task.error && (
        <div className="task-error" title={task.error}>{task.error}</div>
      )}
    </div>
  );
}

export default function TaskPanel() {
  const tasks = useTaskStore((s) => s.tasks);
  const panelOpen = useTaskStore((s) => s.panelOpen);
  const setPanelOpen = useTaskStore((s) => s.setPanelOpen);
  const clearFinished = useTaskStore((s) => s.clearFinished);

  if (tasks.length === 0) return null;

  const running = tasks.filter((t) => t.status === 'installing').length;
  const success = tasks.filter((t) => t.status === 'success').length;
  const failed = tasks.filter((t) => t.status === 'failed').length;

  return (
    <div className={`task-panel ${panelOpen ? 'open' : 'collapsed'}`}>
      <div className="task-panel-head" onClick={() => setPanelOpen(!panelOpen)}>
        <span className="task-panel-title">
          安装任务 {running > 0 && `· 进行中 ${running}`}
          {success > 0 && ` · 成功 ${success}`}
          {failed > 0 && ` · 失败 ${failed}`}
        </span>
        <div className="task-panel-actions" onClick={(e) => e.stopPropagation()}>
          <Button
            type="text"
            size="small"
            icon={<DeleteOutlined />}
            onClick={clearFinished}
            disabled={running === tasks.length}
            title="清除已完成"
          />
          <Button
            type="text"
            size="small"
            icon={panelOpen ? <DownOutlined /> : <UpOutlined />}
            onClick={() => setPanelOpen(!panelOpen)}
          />
          <Button
            type="text"
            size="small"
            icon={<CloseOutlined />}
            onClick={() => useTaskStore.setState({ tasks: [] })}
            title="关闭"
          />
        </div>
      </div>
      {panelOpen && (
        <div className="task-panel-body">
          {tasks.length === 0
            ? <Empty description="暂无任务" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            : tasks.map((t) => <TaskRow key={t.id} task={t} />)
          }
        </div>
      )}
    </div>
  );
}
