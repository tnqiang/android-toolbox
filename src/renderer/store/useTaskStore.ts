import { create } from 'zustand';

export type InstallTaskStatus = 'installing' | 'success' | 'failed';

export interface InstallTask {
  id: string;
  apk: string;            // 完整路径
  apkName: string;        // 文件名
  status: InstallTaskStatus;
  percent: number;        // 0-100
  stage: string;          // pushing / installing / done / failed
  error?: string;
  createdAt: number;
  finishedAt?: number;
}

interface TaskState {
  tasks: InstallTask[];
  panelOpen: boolean;

  upsertTask: (patch: Pick<InstallTask, 'apk'> & Partial<InstallTask>) => void;
  clearFinished: () => void;
  setPanelOpen: (b: boolean) => void;
}

function basenameOf(p: string): string {
  const m = p.match(/[\\/]([^\\/]+)$/);
  return m ? m[1] : p;
}

export const useTaskStore = create<TaskState>((set) => ({
  tasks: [],
  panelOpen: false,

  upsertTask: (patch) =>
    set((s) => {
      const idx = s.tasks.findIndex((t) => t.apk === patch.apk);
      if (idx === -1) {
        const next: InstallTask = {
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          apk: patch.apk,
          apkName: basenameOf(patch.apk),
          status: patch.status ?? 'installing',
          percent: patch.percent ?? 0,
          stage: patch.stage ?? 'starting',
          error: patch.error,
          createdAt: Date.now(),
          finishedAt: patch.status && patch.status !== 'installing' ? Date.now() : undefined,
        };
        return { tasks: [...s.tasks, next], panelOpen: true };
      }
      const prev = s.tasks[idx];
      const merged: InstallTask = {
        ...prev,
        status: patch.status ?? prev.status,
        percent: patch.percent != null ? Math.max(prev.percent, patch.percent) : prev.percent,
        stage: patch.stage ?? prev.stage,
        error: patch.error ?? prev.error,
        finishedAt:
          patch.status && patch.status !== 'installing'
            ? Date.now()
            : prev.finishedAt,
      };
      const arr = s.tasks.slice();
      arr[idx] = merged;
      return { tasks: arr };
    }),

  clearFinished: () =>
    set((s) => ({
      tasks: s.tasks.filter((t) => t.status === 'installing'),
    })),

  setPanelOpen: (b) => set({ panelOpen: b }),
}));
