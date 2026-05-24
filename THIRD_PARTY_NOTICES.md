# 第三方组件声明 / Third Party Notices

本项目使用了以下第三方软件，特此致谢并声明其授权协议。

---

## Android Debug Bridge (adb)

- 来源：[Android Open Source Project · platform-tools](https://developer.android.com/tools/releases/platform-tools)
- 授权：[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)
- 用途：与 Android 设备进行通信
- 分发：本仓库 `resources/adb/windows/` 下随发行版分发的 `adb.exe`、`AdbWinApi.dll`、`AdbWinUsbApi.dll` 来自 Google 官方 Platform-Tools，未做任何修改

```
Copyright (C) The Android Open Source Project
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0
```

---

## Node.js 依赖

本项目运行时依赖（节选，完整请见 `package.json`）：

| 包 | 许可证 |
|---|---|
| electron | MIT |
| react / react-dom | MIT |
| antd | MIT |
| @ant-design/icons | MIT |
| @devicefarmer/adbkit | Apache-2.0 |
| app-info-parser | MIT |
| zustand | MIT |

完整许可证文本随 `node_modules` 一同提供，或可在各项目主页查阅。

---

## 商标说明

- "Android" 是 Google LLC 的商标。本项目与 Google 无任何关联，仅为面向 Android 用户的第三方工具。
- 应用名称 "android-toolbox" 与任何同名商业产品无关联。
