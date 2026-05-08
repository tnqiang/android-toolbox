/**
 * 文件浏览器：用于浏览安卓应用的文档目录。
 *
 * 功能：
 * 1. 面包屑导航、刷新、上一级
 * 2. 列出文件与目录（目录优先）
 * 3. 工具栏：上传（push）/ 下载（pull）/ 删除 / 新建目录
 * 4. 拖拽：从 PC 拖入文件/目录 → 上传到当前目录
 * 5. 双击目录进入；右键（或按钮）下载文件
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Drawer, Table, Breadcrumb, Input, Button, Popconfirm, Modal, App as AntdApp, Empty,
  Tooltip, Typography,
} from 'antd';
import {
  ArrowUpOutlined, ReloadOutlined, FolderAddOutlined, DownloadOutlined,
  UploadOutlined, DeleteOutlined, FolderFilled, FileOutlined, HomeOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { RemoteEntry } from '@shared/types';

interface Props {
  open: boolean;
  onClose: () => void;
  deviceId: string;
  title?: string;
  /** 初始路径，如 /sdcard/Android/data/<pkg>/ */
  initialPath: string;
}

/** 字节数格式化 */
function fmtSize(n?: number): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtTime(ms: number): string {
  if (!ms) return '';
  try {
    const d = new Date(ms);
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${mo}-${da} ${h}:${mi}`;
  } catch { return ''; }
}

function norm(p: string): string {
  if (!p) return '/';
  const s = p.replace(/\\/g, '/');
  if (s === '/') return '/';
  return s.endsWith('/') ? s.slice(0, -1) : s;
}
function parentOf(p: string): string {
  const s = norm(p);
  if (s === '/' || !s.includes('/')) return '/';
  const i = s.lastIndexOf('/');
  return i <= 0 ? '/' : s.slice(0, i);
}
function joinPath(base: string, name: string): string {
  const b = norm(base);
  return b === '/' ? `/${name}` : `${b}/${name}`;
}

export default function FileBrowserDrawer({
  open, onClose, deviceId, initialPath, title,
}: Props) {
  const { message, modal } = AntdApp.useApp();

  const [cwd, setCwd] = useState<string>(norm(initialPath) || '/');
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const [err, setErr] = useState<string>('');
  const [dragOver, setDragOver] = useState(false);

  // 每次 open 或 initialPath 变化时重置 cwd
  const openedRef = useRef(false);
  useEffect(() => {
    if (open && !openedRef.current) {
      openedRef.current = true;
      setCwd(norm(initialPath) || '/');
      setSelectedKeys([]);
    }
    if (!open) openedRef.current = false;
  }, [open, initialPath]);

  const refresh = useCallback(async (path: string) => {
    setLoading(true);
    setErr('');
    try {
      const r = await window.api.fsList(deviceId, path);
      if (!r.ok) {
        setErr(r.error || '读取失败');
        setEntries([]);
      } else {
        setEntries(r.data ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    if (!open) return;
    refresh(cwd);
  }, [open, cwd, refresh]);

  // 面包屑分段
  const crumbs = useMemo(() => {
    const segs = cwd.split('/').filter(Boolean);
    const parts: { label: string; path: string }[] = [{ label: '/', path: '/' }];
    let acc = '';
    for (const s of segs) {
      acc += `/${s}`;
      parts.push({ label: s, path: acc });
    }
    return parts;
  }, [cwd]);

  const goInto = (name: string) => setCwd(joinPath(cwd, name));
  const goUp = () => setCwd(parentOf(cwd));

  // ============ 操作 ============

  /** 下载选中项到本地 */
  const onDownload = async () => {
    const selected = entries.filter((e) => selectedKeys.includes(e.name));
    if (selected.length === 0) return;

    // 单文件 → 另存为；多项或包含目录 → 选目录
    if (selected.length === 1 && !selected[0].isDir) {
      const r = await window.api.pickSaveFile(selected[0].name);
      if (!r.ok || !r.data) return;
      message.loading({ content: '下载中…', key: 'dl', duration: 0 });
      const resp = await window.api.fsPull(
        deviceId, joinPath(cwd, selected[0].name), r.data, selected[0].size,
      );
      if (resp.ok) message.success({ content: `已保存：${r.data}`, key: 'dl' });
      else message.error({ content: `下载失败：${resp.error}`, key: 'dl' });
      return;
    }
    const d = await window.api.pickDirectory();
    if (!d.ok || !d.data) return;
    const items = selected.map((e) => ({
      path: joinPath(cwd, e.name),
      name: e.name,
      isDir: e.isDir,
      size: e.size,
    }));
    message.loading({ content: `下载 ${items.length} 项…`, key: 'dl', duration: 0 });
    const resp = await window.api.fsPullMany(deviceId, items, d.data);
    if (resp.ok) {
      const failed = (resp.data ?? []).filter((x) => !x.ok);
      if (failed.length) message.warning({ content: `部分失败：${failed.length} 项`, key: 'dl' });
      else message.success({ content: `已下载 ${items.length} 项到 ${d.data}`, key: 'dl' });
    } else {
      message.error({ content: `下载失败：${resp.error}`, key: 'dl' });
    }
  };

  /** 上传 PC 文件到当前目录（来自文件选择器） */
  const onUpload = async () => {
    const r = await window.api.pickFiles();
    if (!r.ok || !r.data?.length) return;
    await doPush(r.data);
  };

  /** 实际执行上传 */
  const doPush = useCallback(async (localPaths: string[]) => {
    if (!localPaths.length) return;
    message.loading({ content: `上传 ${localPaths.length} 项…`, key: 'up', duration: 0 });
    const r = await window.api.fsPushMany(deviceId, localPaths, cwd);
    if (r.ok) {
      const failed = (r.data ?? []).filter((x) => !x.ok);
      if (failed.length) message.warning({ content: `部分失败：${failed.length} 项`, key: 'up' });
      else message.success({ content: `已上传 ${localPaths.length} 项`, key: 'up' });
      refresh(cwd);
    } else {
      message.error({ content: `上传失败：${r.error}`, key: 'up' });
    }
  }, [cwd, deviceId, message, refresh]);

  /** 删除选中 */
  const onDelete = async () => {
    const selected = entries.filter((e) => selectedKeys.includes(e.name));
    if (!selected.length) return;
    modal.confirm({
      title: `确认删除选中的 ${selected.length} 项？`,
      content: '该操作不可撤销。',
      okType: 'danger',
      okText: '删除',
      cancelText: '取消',
      onOk: async () => {
        for (const ent of selected) {
          const r = await window.api.fsRm(deviceId, joinPath(cwd, ent.name));
          if (!r.ok) { message.error(`删除失败：${ent.name} - ${r.error}`); return; }
        }
        message.success(`已删除 ${selected.length} 项`);
        setSelectedKeys([]);
        refresh(cwd);
      },
    });
  };

  /** 新建目录 */
  const onMkdir = () => {
    let name = '';
    modal.confirm({
      title: '新建文件夹',
      content: (
        <Input
          autoFocus
          placeholder="文件夹名称"
          onChange={(e) => { name = e.target.value.trim(); }}
        />
      ),
      okText: '创建',
      cancelText: '取消',
      onOk: async () => {
        if (!name) { message.warning('名称不能为空'); return; }
        const r = await window.api.fsMkdir(deviceId, joinPath(cwd, name));
        if (r.ok) { message.success(`已创建 ${name}`); refresh(cwd); }
        else message.error(`创建失败：${r.error}`);
      },
    });
  };

  // ============ 拖拽上传 ============
  const dragCounterRef = useRef(0);
  useEffect(() => {
    if (!open) return;

    // 告诉全局 App：文件浏览器已打开，不要接管拖拽（避免触发 APK 安装）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__fileBrowserOpen = true;

    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      dragCounterRef.current++;
      setDragOver(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      }
    };
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
      if (dragCounterRef.current === 0) setDragOver(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setDragOver(false);
      const fl = e.dataTransfer?.files;
      if (!fl || fl.length === 0) return;
      const paths: string[] = [];
      for (let i = 0; i < fl.length; i++) {
        const f = fl[i];
        if (!f) continue;
        const p = window.api.getPathForFile(f);
        if (p) paths.push(p);
      }
      if (paths.length === 0) {
        message.warning('未能识别到本地路径');
        return;
      }
      doPush(paths);
    };

    window.addEventListener('dragenter', onDragEnter, true);
    window.addEventListener('dragover', onDragOver, true);
    window.addEventListener('dragleave', onDragLeave, true);
    window.addEventListener('drop', onDrop, true);
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__fileBrowserOpen = false;
      window.removeEventListener('dragenter', onDragEnter, true);
      window.removeEventListener('dragover', onDragOver, true);
      window.removeEventListener('dragleave', onDragLeave, true);
      window.removeEventListener('drop', onDrop, true);
    };
  }, [open, doPush, message]);

  // ============ 列定义 ============
  const columns: ColumnsType<RemoteEntry> = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      sorter: (a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      },
      render: (_v, r) => (
        <span
          className="fb-name"
          onDoubleClick={() => {
            if (r.isDir) goInto(r.name);
          }}
        >
          {r.isDir
            ? <FolderFilled style={{ color: '#f7b84b', fontSize: 18, marginRight: 8 }} />
            : <FileOutlined style={{ color: '#8c8c8c', fontSize: 16, marginRight: 8 }} />
          }
          {r.name}
          {r.isSymlink && <span style={{ color: '#bfbfbf', marginLeft: 6 }}>↗</span>}
        </span>
      ),
    },
    {
      title: '大小',
      dataIndex: 'size',
      key: 'size',
      width: 110,
      sorter: (a, b) => a.size - b.size,
      render: (_v, r) => (r.isDir ? '' : fmtSize(r.size)),
    },
    {
      title: '修改时间',
      dataIndex: 'mtimeMs',
      key: 'mtime',
      width: 160,
      sorter: (a, b) => a.mtimeMs - b.mtimeMs,
      render: (v: number) => fmtTime(v),
    },
  ];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      placement="right"
      width="70%"
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span>{title ?? '文件浏览'}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 'normal' }}>
            拖拽文件到此上传
          </Typography.Text>
        </div>
      }
      styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column' } }}
      maskClosable
    >
      {/* 工具栏 */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px',
          borderBottom: '1px solid #f0f0f0', flexShrink: 0,
        }}
      >
        <Tooltip title="上一级"><Button icon={<ArrowUpOutlined />} onClick={goUp} disabled={cwd === '/'} /></Tooltip>
        <Tooltip title="回到应用文档主目录">
          <Button
            icon={<HomeOutlined />}
            onClick={() => setCwd(norm(initialPath) || '/')}
          />
        </Tooltip>
        <Tooltip title="刷新"><Button icon={<ReloadOutlined />} onClick={() => refresh(cwd)} loading={loading} /></Tooltip>
        <Tooltip title="新建文件夹"><Button icon={<FolderAddOutlined />} onClick={onMkdir} /></Tooltip>

        <div style={{ flex: 1 }} />

        <Button
          icon={<DownloadOutlined />}
          disabled={selectedKeys.length === 0}
          onClick={onDownload}
        >
          下载 ({selectedKeys.length})
        </Button>
        <Button icon={<UploadOutlined />} onClick={onUpload}>上传</Button>
        <Popconfirm
          title={`确认删除 ${selectedKeys.length} 项？`}
          onConfirm={onDelete}
          disabled={selectedKeys.length === 0}
        >
          <Button icon={<DeleteOutlined />} danger disabled={selectedKeys.length === 0}>
            删除
          </Button>
        </Popconfirm>
      </div>

      {/* 面包屑 */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid #f0f0f0', flexShrink: 0, overflow: 'hidden' }}>
        <Breadcrumb
          items={crumbs.map((c, i) => ({
            title: (
              <span
                style={{ cursor: i === crumbs.length - 1 ? 'default' : 'pointer', color: i === crumbs.length - 1 ? '#262626' : '#1677ff' }}
                onClick={() => { if (i !== crumbs.length - 1) setCwd(c.path); }}
              >
                {c.label}
              </span>
            ),
          }))}
        />
      </div>

      {/* 主体列表 */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
        {err ? (
          <div style={{ padding: 24 }}>
            <Empty
              description={
                <>
                  <div style={{ color: '#cf1322', marginBottom: 6 }}>{err}</div>
                  <div style={{ fontSize: 12, color: '#8c8c8c' }}>
                    Android 11+ 对 /Android/data 有访问限制；未 root 设备可能无法访问部分路径。
                  </div>
                </>
              }
            />
          </div>
        ) : (
          <Table<RemoteEntry>
            rowKey="name"
            dataSource={entries}
            columns={columns}
            loading={loading}
            size="middle"
            pagination={false}
            scroll={{ y: 'calc(100vh - 280px)' }}
            rowSelection={{
              selectedRowKeys: selectedKeys,
              onChange: setSelectedKeys,
            }}
            onRow={(r) => ({
              onDoubleClick: () => { if (r.isDir) goInto(r.name); },
            })}
          />
        )}

        {dragOver && (
          <div
            style={{
              position: 'absolute', inset: 0,
              background: 'rgba(22,119,255,0.08)',
              border: '2px dashed #1677ff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              pointerEvents: 'none',
              fontSize: 18, color: '#1677ff', fontWeight: 500,
            }}
          >
            松开以上传到：{cwd}
          </div>
        )}
      </div>
    </Drawer>
  );
}
