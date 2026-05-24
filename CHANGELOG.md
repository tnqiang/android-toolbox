# Changelog

本项目所有显著变更都会记录在此文件。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.5.5] - 2026-05

### Added
- 应用列表新增"OEM 厂商"分类：从原"系统应用"中拆分出设备厂商预装应用单独成组，三类（用户应用 / OEM 厂商 / 系统应用）一目了然

### Changed
- 应用图标更新做优先级处理，避免列表刷新时图标抖动 / 错位

## [0.5.4] - 2026-05

### Changed
- 产品名由"手机助手"改为 `android-toolbox`，更国际化
  - 安装包文件名：`android-toolbox Setup x.x.x.exe`
  - 桌面 / 开始菜单快捷方式：`android-toolbox`
  - 应用窗口标题、TopBar 显示文字
  - 缓存目录从 `%APPDATA%\手机助手\` 迁移到 `%APPDATA%\android-toolbox\`（旧目录数据保留，可手动删除）
- 应用唯一标识 `appId` 由 `com.mobilehelper.app` 改为 `com.tnqiang.android-toolbox`
  - ⚠️ 由 0.5.3 升级到 0.5.4 时，Windows 会将其视作两个不同应用，**旧版不会自动卸载**
  - 建议先卸载 0.5.3，再安装 0.5.4；或在控制面板里手动卸载残留的旧版

## [0.5.3] - 2026-05

### Fixed
- 应用名称解析优先取简体中文，修复部分应用（如和平精英）被显示为繁体的问题
- 设备详情：左右两列上下严格对齐

### Changed
- 设备详情：移除冗余的"刷新设备详情"按钮
- 横屏截图（游戏横屏）在 mock 框里旋转回正显示，外框尺寸按截图比例自适应

## [0.5.2]

### Added
- 视频页签

## [0.4.1]

### Fixed
- 修复启动时双击 APK 误报"请先连接设备"

## [0.4.0]

### Added
- 相册功能：浏览设备图片并支持复制到 PC
- 使用自定义 `media://` 协议替代 `file://` 加载缩略图，规避 Electron 安全限制

## [0.3.8]

### Fixed
- 右键菜单在失去焦点后主动关闭

## [0.3.7]

### Added
- APK 双击打开自动安装

## [0.3.6]

### Added
- 右键菜单：创建引擎热更目录

## [0.2.1]

### Changed
- 文件浏览器性能优化，流式展示
- 安装速度按实际传输量统计

### Fixed
- 安装失败时增加错误信息提示
- 截图展示方向修复

## [0.0.1]

- 首次发布
