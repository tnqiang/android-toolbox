# 内置 ADB 二进制

打包发布时，需要把 platform-tools 的 adb 放在这里，目录结构：

```
resources/adb/
  ├── windows/
  │     ├── adb.exe
  │     ├── AdbWinApi.dll
  │     └── AdbWinUsbApi.dll
  ├── macos/
  │     └── adb
  └── linux/
        └── adb
```

下载地址（Google 官方 Platform-Tools）：
- Windows: https://dl.google.com/android/repository/platform-tools-latest-windows.zip
- macOS:   https://dl.google.com/android/repository/platform-tools-latest-darwin.zip
- Linux:   https://dl.google.com/android/repository/platform-tools-latest-linux.zip

> 开发阶段如未放置二进制，会回退到使用系统 PATH 中的 adb。
> 请确保本机已安装 platform-tools 并能在终端执行 `adb version`。
