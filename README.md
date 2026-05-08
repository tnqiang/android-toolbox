# APK 装包助手 (ApkInstallHelper)

> 跨平台（Windows / macOS）的安卓应用管理工具，参考爱思助手的形态。
> 基于 Electron + React + adbkit 构建。

## 功能

- ✅ 自动识别 USB 连接的安卓设备（实时插拔感知）
- ✅ 设备信息展示（品牌/型号/Android 版本/SDK）
- ✅ 应用列表（用户/系统/全部，支持搜索、分页、批量选择）
- ✅ 拖拽 / 多选安装 APK（批量、含进度反馈）
- ✅ 卸载应用（单个 / 批量）
- ✅ 导出 APK（备份）到本地目录
- 🔜 应用图标/名称解析（aapt / apk-parser）
- 🔜 文件管理（push / pull）
- 🔜 截图、录屏、scrcpy 投屏

## 技术栈

- **Electron 32** - 跨平台桌面壳
- **Vite 5 + React 18 + TypeScript** - 前端
- **Ant Design 5** - UI 组件库
- **@adobe/adbkit** - 纯 Node 实现的 adb 协议客户端
- **zustand** - 状态管理
- **electron-builder** - 打包

## 项目结构

```
src/
├── main/            # Electron 主进程
│   ├── index.ts
│   └── adb/
│       ├── client.ts     # adbkit 客户端
│       ├── device.ts     # 设备列表/插拔追踪
│       ├── package.ts    # 应用列表/装卸/导出
│       └── handlers.ts   # IPC 注册
├── preload/         # 安全暴露 API 给渲染层
│   └── index.ts
├── renderer/        # React 前端
│   ├── App.tsx
│   ├── main.tsx
│   ├── components/  # TopBar / Sidebar
│   ├── pages/       # Apps（应用管理）
│   ├── store/       # zustand store
│   └── styles/
└── shared/
    └── types.ts     # 主/渲染共享类型
```

## 开发运行

### 前置条件

1. **Node.js ≥ 18**
2. 本机安装 [Android Platform-Tools](https://developer.android.com/tools/releases/platform-tools)，`adb` 在 PATH 中
   - 或将 adb 二进制放入 `resources/adb/{windows|macos|linux}/`
3. 安卓设备开启「开发者选项」→「USB 调试」并通过 USB 连接

### 启动

```bash
npm install
npm run dev
```

### 打包

> ⚠️ 打包前需在 `resources/adb/{platform}/` 下放置对应平台的 adb 二进制。

```bash
npm run build
```

产物在 `release/` 目录。

## 设计要点

- **设备插拔追踪**：使用 adbkit 的 `trackDevices()` 长连接，主进程主动推送给渲染层
- **批量安装**：在主进程串行 install，每一步通过 IPC 推送进度
- **应用详情懒加载**：列表先返回包名 + APK 路径，再以并发 6 的工作池拉取 versionName/versionCode

## License

MIT
