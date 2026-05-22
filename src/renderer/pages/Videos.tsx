/**
 * 视频页面：扫描设备上的视频 -> 缩略图网格（首帧封面 + 时长角标）-> 点击播放
 *
 * 复用与相册相同的基础设施：
 *   - window.api.mediaScan(deviceId, 'video')          扫描（DCIM/Movies/Pictures，mp4/mkv/...）
 *   - window.api.mediaLocalUrl(...)                     按需 pull -> media:// 协议 URL
 *   - window.api.fsPullMany(...)                        批量复制到 PC
 *   - window.api.mediaReveal(localUrl)                  在系统文件管理器中显示
 *
 * 关键差异（相对相册）：
 *   1) 缩略图：渲染一个隐藏的 <video preload="metadata"> 拿首帧 -> 画到 <canvas>
 *      -> 用 dataURL 当封面图。失败时回退到一个图标占位。
 *   2) 角标：右下角显示视频时长（mm:ss / hh:mm:ss）。
 *   3) 点击：用一个内置的 <video controls autoplay> 模态做大播放，避免依赖系统播放器。
 *      模态内提供"在系统播放器打开（实际上是 reveal 到本地缓存）/ 复制到电脑"。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button, Empty, Space, Spin, App as AntdApp, Checkbox, Tooltip, Modal,
  Typography,
} from 'antd';
import {
  ReloadOutlined, DownloadOutlined, ClearOutlined, FolderOpenOutlined,
  PlayCircleFilled, VideoCameraOutlined,
} from '@ant-design/icons';
import type { MediaEntry } from '@shared/types';
import { useAppStore } from '../store/useAppStore';

const { Text } = Typography;

const THUMB_SIZE = 180;

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

function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** 按年-月分组（与相册一致） */
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
  const keys = Array.from(map.keys()).sort((a, b) => (a < b ? 1 : -1));
  return keys.map((k) => ({
    key: k,
    label: k === '未知' ? '未知' : `${k.slice(0, 4)}年${k.slice(5)}月`,
    items: map.get(k)!,
  }));
}

/**
 * 单个视频缩略图：
 *  - 进入视口时才向主进程要 mediaLocalUrl（拉到本地缓存得到 media://... URL）
 *  - 拿到 URL 后，用一个隐藏的 <video> 加载 metadata 取 duration，
 *    再 seek 到 0.1s 抓一帧到 canvas，得到 dataURL 当封面。
 */
interface ThumbProps {
  entry: MediaEntry;
  deviceId: string;
  selected: boolean;
  onToggleSelect: (path: string) => void;
  onPlay: (entry: MediaEntry, localUrl: string) => void;
}
function VideoThumb({ entry, deviceId, selected, onToggleSelect, onPlay }: ThumbProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [poster, setPoster] = useState<string | null>(null);
  const [duration, setDuration] = useState<number>(0);
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

  // 拿到 URL 后抓首帧封面
  useEffect(() => {
    if (!url || poster || error) return;
    let cancelled = false;
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'metadata';
    v.crossOrigin = 'anonymous';
    v.src = url;

    const cleanup = () => {
      v.removeAttribute('src');
      try { v.load(); } catch { /* noop */ }
    };

    const onLoadedMeta = () => {
      if (cancelled) return;
      if (Number.isFinite(v.duration) && v.duration > 0) setDuration(v.duration);
      // seek 一点点避免取到全黑首帧
      try {
        v.currentTime = Math.min(0.1, Math.max(0, (v.duration || 0) * 0.02));
      } catch { /* ignore */ }
    };
    const onSeeked = () => {
      if (cancelled) return;
      try {
        const w = v.videoWidth;
        const h = v.videoHeight;
        if (w > 0 && h > 0) {
          // 缩到 ~360px 宽以省内存
          const targetW = Math.min(360, w);
          const targetH = Math.round((h / w) * targetW);
          const c = document.createElement('canvas');
          c.width = targetW;
          c.height = targetH;
          const ctx = c.getContext('2d');
          if (ctx) {
            ctx.drawImage(v, 0, 0, targetW, targetH);
            try {
              setPoster(c.toDataURL('image/jpeg', 0.82));
            } catch {
              // 极少数 codec 下 toDataURL 可能因 tainted canvas 失败 —— 忽略，回退占位
            }
          }
        }
      } finally {
        cleanup();
      }
    };
    const onErr = () => {
      if (cancelled) return;
      setError(true);
      cleanup();
    };

    v.addEventListener('loadedmetadata', onLoadedMeta);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('error', onErr);

    return () => {
      cancelled = true;
      v.removeEventListener('loadedmetadata', onLoadedMeta);
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('error', onErr);
      cleanup();
    };
  }, [url, poster, error]);

  const onClick = () => {
    if (!url) return;
    onPlay(entry, url);
  };

  return (
    <div
      ref={ref}
      style={{
        position: 'relative',
        width: '100%',
        aspectRatio: '16 / 10',
        background: '#1f1f1f',
        borderRadius: 6,
        overflow: 'hidden',
        cursor: url ? 'pointer' : 'default',
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

      {poster ? (
        // eslint-disable-next-line jsx-a11y/alt-text
        <img
          src={poster}
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
      ) : url ? (
        // 已经拿到 URL 但还在抽帧
        <div style={{
          width: '100%', height: '100%', display: 'flex',
          alignItems: 'center', justifyContent: 'center', color: '#666',
        }}>
          <VideoCameraOutlined style={{ fontSize: 36 }} />
        </div>
      ) : (
        <div style={{
          width: '100%', height: '100%', display: 'flex',
          alignItems: 'center', justifyContent: 'center', color: '#888',
        }}>
          <Spin size="small" />
        </div>
      )}

      {/* 中间：播放按钮（hover 增强） */}
      {url && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            color: 'rgba(255,255,255,0.85)',
            textShadow: '0 2px 6px rgba(0,0,0,0.5)',
            fontSize: 40,
          }}
        >
          <PlayCircleFilled />
        </div>
      )}

      {/* 时长角标：右下角 */}
      {duration > 0 && (
        <div style={{
          position: 'absolute',
          right: 6, bottom: 22,
          background: 'rgba(0,0,0,0.6)',
          color: '#fff',
          fontSize: 11,
          padding: '0 6px',
          borderRadius: 3,
          lineHeight: '16px',
          height: 16,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {fmtDuration(duration)}
        </div>
      )}

      {/* 文件名条 */}
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

export default function VideosPage() {
  const { message } = AntdApp.useApp();
  const deviceId = useAppStore((s) => s.currentDeviceId);

  const [loading, setLoading] = useState(false);
  const [list, setList] = useState<MediaEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // 播放态
  const [playing, setPlaying] = useState<{ entry: MediaEntry; url: string } | null>(null);

  // 扫描
  const scan = useCallback(async () => {
    if (!deviceId) { setList([]); return; }
    setLoading(true);
    try {
      const resp = await window.api.mediaScan(deviceId, 'video');
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

  const onPlay = useCallback((entry: MediaEntry, localUrl: string) => {
    setPlaying({ entry, url: localUrl });
  }, []);

  // 复制到 PC
  const onCopyToPc = useCallback(async () => {
    if (!deviceId) return;
    const items = list.filter((x) => selected.has(x.path));
    if (items.length === 0) {
      message.info('请先选择要复制的视频');
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
    if (failCnt === 0) message.success(`已复制 ${okCnt} 个视频到 ${dir.data}`);
    else message.warning(`成功 ${okCnt} / 失败 ${failCnt}`);
  }, [deviceId, list, selected, message]);

  const onRevealCurrent = useCallback(async () => {
    if (!playing) return;
    const r = await window.api.mediaReveal(playing.url);
    if (!r.ok) message.error(`定位失败：${r.error}`);
  }, [playing, message]);

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
          {loading ? '扫描中…' : `共 ${list.length} 个`}
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
            <Spin tip="扫描设备视频中…" />
          </div>
        ) : list.length === 0 ? (
          <Empty description="未在设备上找到视频（已扫描 DCIM / Movies / Pictures）" />
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
                  <Text type="secondary" style={{ fontSize: 12 }}>{g.items.length} 个</Text>
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
                  gap: 10,
                }}>
                  {g.items.map((it) => (
                    <VideoThumb
                      key={it.path}
                      entry={it}
                      deviceId={deviceId}
                      selected={selected.has(it.path)}
                      onToggleSelect={toggleSelect}
                      onPlay={onPlay}
                    />
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 播放器 Modal */}
      <Modal
        open={!!playing}
        onCancel={() => setPlaying(null)}
        title={playing?.entry.name}
        width={880}
        centered
        destroyOnClose
        footer={
          <Space>
            <Button icon={<FolderOpenOutlined />} onClick={onRevealCurrent}>
              在文件管理器中显示
            </Button>
            <Button onClick={() => setPlaying(null)}>关闭</Button>
          </Space>
        }
      >
        {playing && (
          <div style={{ background: '#000', borderRadius: 4 }}>
            <video
              key={playing.url}
              src={playing.url}
              controls
              autoPlay
              style={{
                width: '100%',
                maxHeight: '70vh',
                display: 'block',
                background: '#000',
                borderRadius: 4,
              }}
            />
          </div>
        )}
        {playing && (
          <div style={{ marginTop: 8, color: '#8c8c8c', fontSize: 12 }}>
            {fmtSize(playing.entry.size)} · {fmtDate(playing.entry.mtimeMs)} · {playing.entry.path}
          </div>
        )}
      </Modal>
    </div>
  );
}
