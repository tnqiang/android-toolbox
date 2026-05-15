/**
 * 相册页面：扫描设备上的图片 -> 缩略图网格 -> 点击放大预览 -> 选中后批量复制到 PC
 *
 * 关键设计：
 *  1) 设备扫描结果（路径 + size + mtime）一次性拿回；
 *  2) 缩略图按需懒加载：每个 tile 进入视口时调用 mediaLocalUrl，
 *     主进程 pull 到本地缓存目录后返回 file:// URL，<img> 直接渲染。
 *  3) 同一文件在主进程有 inFlight Map 去重，避免重复 pull；
 *     缓存文件名包含 sha1(deviceId+path+mtime+size)，下次进页面直接命中。
 *  4) 点击预览用 antd Image.PreviewGroup —— src 用本地 file://。
 *  5) 批量复制：fsPullMany（已有），用户选目录即可。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button, Empty, Image, Space, Spin, App as AntdApp, Checkbox, Tooltip,
  Typography,
} from 'antd';
import {
  ReloadOutlined, DownloadOutlined, FolderOpenOutlined, ClearOutlined,
} from '@ant-design/icons';
import type { MediaEntry } from '@shared/types';
import { useAppStore } from '../store/useAppStore';

const { Text } = Typography;

/** tile 尺寸：和 grid 配合（grid-template-columns: repeat(auto-fill, minmax(THUMB_SIZE, 1fr))) */
const THUMB_SIZE = 140;

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDate(ms: number): string {
  if (!ms) return '';
  try {
    const d = new Date(ms);
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    return `${y}-${mo}-${da}`;
  } catch { return ''; }
}

/** 按年-月分组，组内已是 mtime 倒序 */
function groupByMonth(list: MediaEntry[]): { key: string; label: string; items: MediaEntry[] }[] {
  const map = new Map<string, MediaEntry[]>();
  for (const it of list) {
    let key = '未知';
    if (it.mtimeMs) {
      const d = new Date(it.mtimeMs);
      key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    let arr = map.get(key);
    if (!arr) { arr = []; map.set(key, arr); }
    arr.push(it);
  }
  // 月份倒序（最新在前）
  const keys = Array.from(map.keys()).sort((a, b) => (a < b ? 1 : -1));
  return keys.map((k) => ({
    key: k,
    label: k === '未知' ? '未知' : `${k.slice(0, 4)}年${k.slice(5)}月`,
    items: map.get(k)!,
  }));
}

/**
 * 单个缩略图 tile：自管"进入视口"才发 pull 请求，避免一次性把成百上千张图都拉下来。
 */
interface ThumbProps {
  entry: MediaEntry;
  deviceId: string;
  selected: boolean;
  onToggleSelect: (path: string) => void;
  onPreview: (entry: MediaEntry, localUrl: string) => void;
}
function Thumb({ entry, deviceId, selected, onToggleSelect, onPreview }: ThumbProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // 进入视口才触发 pull
  useEffect(() => {
    const el = ref.current;
    if (!el || url || error) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          io.disconnect();
          window.api
            .mediaLocalUrl(deviceId, {
              path: entry.path, mtimeMs: entry.mtimeMs, size: entry.size,
            })
            .then((r) => {
              if (r.ok && r.data) setUrl(r.data);
              else setError(true);
            })
            .catch(() => setError(true));
          break;
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [deviceId, entry.path, entry.mtimeMs, entry.size, url, error]);

  const onClick = () => {
    if (!url) return;
    onPreview(entry, url);
  };

  return (
    <div
      ref={ref}
      style={{
        position: 'relative',
        width: '100%',
        aspectRatio: '1 / 1',
        background: '#1f1f1f',
        borderRadius: 6,
        overflow: 'hidden',
        cursor: url ? 'zoom-in' : 'default',
        border: selected ? '2px solid #1677ff' : '2px solid transparent',
      }}
      title={`${entry.name}\n${fmtSize(entry.size)} · ${fmtDate(entry.mtimeMs)}\n${entry.path}`}
      onClick={onClick}
    >
      {/* 选择框：左上角 */}
      <Checkbox
        checked={selected}
        onClick={(e) => e.stopPropagation()}
        onChange={() => onToggleSelect(entry.path)}
        style={{
          position: 'absolute',
          top: 4, left: 6,
          zIndex: 2,
          background: 'rgba(0,0,0,0.45)',
          borderRadius: 4,
          padding: '0 4px',
        }}
      />
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
        <img
          src={url}
          loading="lazy"
          draggable={false}
          style={{
            width: '100%', height: '100%', objectFit: 'cover',
            display: 'block', userSelect: 'none', pointerEvents: 'none',
          }}
        />
      ) : error ? (
        <div style={{
          width: '100%', height: '100%', display: 'flex',
          alignItems: 'center', justifyContent: 'center', color: '#888',
          fontSize: 12, padding: 8, textAlign: 'center',
        }}>加载失败</div>
      ) : (
        <div style={{
          width: '100%', height: '100%', display: 'flex',
          alignItems: 'center', justifyContent: 'center', color: '#888',
        }}>
          <Spin size="small" />
        </div>
      )}

      {/* 文件名/大小：底部条 */}
      <div style={{
        position: 'absolute',
        left: 0, right: 0, bottom: 0,
        padding: '4px 6px',
        background: 'linear-gradient(transparent, rgba(0,0,0,0.65))',
        color: '#fff',
        fontSize: 11,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}>
        {entry.name}
      </div>
    </div>
  );
}

export default function GalleryPage() {
  const { message } = AntdApp.useApp();
  const deviceId = useAppStore((s) => s.currentDeviceId);

  const [loading, setLoading] = useState(false);
  const [list, setList] = useState<MediaEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // 预览态：当前预览的 url 列表（用 antd Image.PreviewGroup）
  const [previewUrls, setPreviewUrls] = useState<string[] | null>(null);
  const [previewIndex, setPreviewIndex] = useState(0);

  // 扫描
  const scan = useCallback(async () => {
    if (!deviceId) { setList([]); return; }
    setLoading(true);
    try {
      const resp = await window.api.mediaScan(deviceId, 'image');
      if (!resp.ok) {
        message.error(`扫描失败：${resp.error}`);
        return;
      }
      setList(resp.data || []);
      setSelected(new Set());
    } finally {
      setLoading(false);
    }
  }, [deviceId, message]);

  useEffect(() => { scan(); }, [scan]);

  const toggleSelect = useCallback((path: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const selectAllInGroup = useCallback((items: MediaEntry[]) => {
    setSelected((s) => {
      const next = new Set(s);
      const allIn = items.every((it) => next.has(it.path));
      if (allIn) {
        for (const it of items) next.delete(it.path);
      } else {
        for (const it of items) next.add(it.path);
      }
      return next;
    });
  }, []);

  const onPreview = useCallback(async (entry: MediaEntry, localUrl: string) => {
    // 把当前 list 的所有 url 都准备好，但只有已有 url 的能直接 preview；
    // 对于其他没有缓存的，点击 next/prev 时再异步拉
    // 简化：先只预览当前一张；切换 N/P 时按需 fetch
    setPreviewUrls([localUrl]);
    setPreviewIndex(0);

    // 异步把其它 url 全部填上：性能允许的话；用户从中间点的可能性更大，
    // 这里改为只把当前周围 ±10 张拉一下，超过的当 next 切到时再拉
    const idx = list.findIndex((x) => x.path === entry.path);
    if (idx < 0) return;
    const radius = 10;
    const fromIdx = Math.max(0, idx - radius);
    const toIdx = Math.min(list.length, idx + radius + 1);
    const slice = list.slice(fromIdx, toIdx);
    const newCenter = idx - fromIdx;

    const urls = await Promise.all(slice.map((it) =>
      it.path === entry.path
        ? Promise.resolve(localUrl)
        : window.api
            .mediaLocalUrl(deviceId!, { path: it.path, mtimeMs: it.mtimeMs, size: it.size })
            .then((r) => (r.ok ? r.data! : ''))
            .catch(() => ''),
    ));
    setPreviewUrls(urls.filter(Boolean));
    setPreviewIndex(Math.max(0, Math.min(urls.filter(Boolean).length - 1, newCenter)));
  }, [deviceId, list]);

  // 复制到 PC：调 fsPullMany
  const onCopyToPc = useCallback(async () => {
    if (!deviceId) return;
    const items = list.filter((x) => selected.has(x.path));
    if (items.length === 0) {
      message.info('请先选择要复制的图片');
      return;
    }
    const dir = await window.api.pickDirectory();
    if (!dir.ok || !dir.data) return;
    const resp = await window.api.fsPullMany(
      deviceId,
      items.map((it) => ({ path: it.path, name: it.name, isDir: false, size: it.size })),
      dir.data,
    );
    if (!resp.ok) {
      message.error(`复制失败：${resp.error}`);
      return;
    }
    const okCnt = (resp.data || []).filter((r) => r.ok).length;
    const failCnt = (resp.data || []).filter((r) => !r.ok).length;
    if (failCnt === 0) message.success(`已复制 ${okCnt} 张照片到 ${dir.data}`);
    else message.warning(`成功 ${okCnt} / 失败 ${failCnt}`);
  }, [deviceId, list, selected, message]);

  const groups = useMemo(() => groupByMonth(list), [list]);

  if (!deviceId) {
    return (
      <div style={{ padding: 24 }}>
        <Empty description="请先连接设备" />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* 工具栏 */}
      <div style={{
        flex: '0 0 auto',
        padding: '10px 16px',
        borderBottom: '1px solid #eee',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <Button icon={<ReloadOutlined />} onClick={scan} loading={loading}>
          重新扫描
        </Button>
        <Button
          type="primary"
          icon={<DownloadOutlined />}
          disabled={selected.size === 0}
          onClick={onCopyToPc}
        >
          复制到电脑{selected.size > 0 ? `（${selected.size}）` : ''}
        </Button>
        {selected.size > 0 && (
          <Button icon={<ClearOutlined />} onClick={() => setSelected(new Set())}>
            取消选择
          </Button>
        )}
        <div style={{ flex: 1 }} />
        <Text type="secondary">
          {loading ? '扫描中…' : `共 ${list.length} 张`}
        </Text>
      </div>

      {/* 网格 */}
      <div style={{
        flex: '1 1 0',
        minHeight: 0,
        overflowY: 'auto',
        padding: 16,
      }}>
        {loading && list.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 48 }}>
            <Spin tip="扫描设备相册中…" />
          </div>
        ) : list.length === 0 ? (
          <Empty description="未在设备上找到图片（已扫描 DCIM / Pictures）" />
        ) : (
          groups.map((g) => {
            const allIn = g.items.every((it) => selected.has(it.path));
            return (
              <div key={g.key} style={{ marginBottom: 28 }}>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  marginBottom: 10,
                  gap: 12,
                }}>
                  <Text strong style={{ fontSize: 15 }}>{g.label}</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>{g.items.length} 张</Text>
                  <Tooltip title={allIn ? '取消选择本组' : '选择本组全部'}>
                    <Button
                      size="small"
                      type="text"
                      onClick={() => selectAllInGroup(g.items)}
                    >
                      {allIn ? '取消全选' : '全选本组'}
                    </Button>
                  </Tooltip>
                </div>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(auto-fill, minmax(${THUMB_SIZE}px, 1fr))`,
                  gap: 8,
                }}>
                  {g.items.map((it) => (
                    <Thumb
                      key={it.path}
                      entry={it}
                      deviceId={deviceId}
                      selected={selected.has(it.path)}
                      onToggleSelect={toggleSelect}
                      onPreview={onPreview}
                    />
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 大图预览 */}
      {previewUrls && previewUrls.length > 0 && (
        <Image.PreviewGroup
          preview={{
            visible: true,
            current: previewIndex,
            onChange: setPreviewIndex,
            onVisibleChange: (v) => { if (!v) setPreviewUrls(null); },
          }}
          items={previewUrls}
        >
          {/* 仅触发预览，不渲染缩略图 */}
          <span style={{ display: 'none' }}>
            {previewUrls.map((u) => <Image key={u} src={u} />)}
          </span>
        </Image.PreviewGroup>
      )}
    </div>
  );
}
