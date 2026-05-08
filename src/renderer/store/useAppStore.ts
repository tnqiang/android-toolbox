import { create } from 'zustand';
import type { AppCategory, AppInfo, DeviceInfo } from '@shared/types';

interface AppState {
  devices: DeviceInfo[];
  currentDeviceId: string | null;

  apps: AppInfo[];
  appCategory: AppCategory;
  appsLoading: boolean;

  setDevices: (devices: DeviceInfo[]) => void;
  setCurrentDevice: (id: string | null) => void;
  setApps: (apps: AppInfo[]) => void;
  setAppCategory: (c: AppCategory) => void;
  setAppsLoading: (b: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  devices: [],
  currentDeviceId: null,
  apps: [],
  appCategory: 'user',
  appsLoading: false,

  setDevices: (devices) => set((s) => {
    // 自动选中第一个在线设备
    let currentDeviceId = s.currentDeviceId;
    const stillOnline = devices.find((d) => d.id === currentDeviceId && d.state === 'device');
    if (!stillOnline) {
      const first = devices.find((d) => d.state === 'device');
      currentDeviceId = first?.id ?? null;
    }
    return { devices, currentDeviceId };
  }),
  setCurrentDevice: (id) => set({ currentDeviceId: id }),
  setApps: (apps) => set({ apps }),
  setAppCategory: (c) => set({ appCategory: c }),
  setAppsLoading: (b) => set({ appsLoading: b }),
}));
