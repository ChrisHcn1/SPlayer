# vcpkg 安装 FFmpeg 集成指南

本文档说明如何通过 vcpkg 安装 FFmpeg 并集成到 SPlayer 项目中。

## 前置要求

- Windows 10 或更高版本
- Git
- Visual Studio 2019 或更高版本（包含 C++ 构建工具）
- PowerShell 7+ 或 Windows PowerShell

## 步骤 1：安装 vcpkg

### 1.1 克隆 vcpkg 仓库

在 PowerShell 中执行：

```powershell
# 克隆 vcpkg 到用户目录
git clone https://github.com/microsoft/vcpkg.git $env:USERPROFILE\vcpkg

# 进入 vcpkg 目录
cd $env:USERPROFILE\vcpkg
```

### 1.2 运行 bootstrap 脚本

```powershell
# Windows 用户运行
.\bootstrap-vcpkg.bat
```

这个过程可能需要几分钟时间，请耐心等待。

### 1.3 集成到系统

```powershell
# 将 vcpkg 集成到全局，这样所有项目都可以使用
.\vcpkg integrate install
```

### 1.4 添加 vcpkg 到 PATH

**临时添加（当前会话）：**

```powershell
$env:Path += ";$env:USERPROFILE\vcpkg"
```

**永久添加：**

1. 右键点击"此电脑" → "属性" → "高级系统设置"
2. 点击"环境变量"
3. 在"用户变量"中找到 `Path`，点击"编辑"
4. 添加新条目：`%USERPROFILE%\vcpkg`
5. 点击"确定"保存

验证安装：

```powershell
vcpkg version
```

应该显示 vcpkg 版本信息。

## 步骤 2：安装 FFmpeg

### 2.1 安装 FFmpeg

```powershell
# 安装 FFmpeg（x64 Windows 平台）
vcpkg install ffmpeg:x64-windows
```

这个过程可能需要 10-30 分钟，取决于网络速度和计算机性能。

**可选：安装其他平台的 FFmpeg**

```powershell
# 如果需要支持 x86 平台
vcpkg install ffmpeg:x86-windows

# 如果需要支持 ARM64 平台
vcpkg install ffmpeg:arm64-windows
```

### 2.2 查找安装路径

```powershell
# 查看 FFmpeg 安装位置
vcpkg list ffmpeg
```

FFmpeg 的库文件通常安装在：

```
C:\Users\<用户名>\vcpkg\installed\x64-windows\
```

## 步骤 3：集成到 SPlayer 项目

### 3.1 创建 CMake 配置

在项目根目录创建 `CMakeLists.txt`（如果还没有）：

```cmake
cmake_minimum_required(VERSION 3.20)
project(SPlayer)

# 设置 C++ 标准
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# 查找 vcpkg 工具链
find_package(ffmpeg CONFIG REQUIRED)

# 包含头文件
target_include_directories(${PROJECT_NAME} PRIVATE
    ${FFMPEG_INCLUDE_DIRS}
)

# 链接 FFmpeg 库
target_link_libraries(${PROJECT_NAME} PRIVATE
    ${FFMPEG_LIBRARIES}
)
```

### 3.2 配置 CMake 使用 vcpkg

在项目根目录创建 `CMakePresets.json`：

```json
{
  "version": 3,
  "configurePresets": [
    {
      "name": "default",
      "displayName": "Default Config",
      "binaryDir": "${sourceDir}/build",
      "cacheVariables": {
        "CMAKE_TOOLCHAIN_FILE": "$env{USERPROFILE}/vcpkg/scripts/buildsystems/vcpkg.cmake"
      }
    }
  ]
}
```

### 3.3 更新 Electron 构建配置

修改 `electron/package.json` 或 `electron-builder.yml`，添加 FFmpeg 依赖：

**方式 1：复制 FFmpeg 二进制文件到项目**

```powershell
# 复制 FFmpeg 可执行文件到项目
Copy-Item "$env:USERPROFILE\vcpkg\installed\x64-windows\tools\ffmpeg\ffmpeg.exe" -Destination "E:\SPlayer\resources\ffmpeg.exe"
```

**方式 2：在构建时自动复制**

在 `package.json` 中添加构建脚本：

```json
{
  "scripts": {
    "postinstall": "node scripts/copy-ffmpeg.js"
  }
}
```

创建 `scripts/copy-ffmpeg.js`：

```javascript
const fs = require("fs");
const path = require("path");
const os = require("os");

const vcpkgPath = path.join(os.homedir(), "vcpkg", "installed", "x64-windows", "tools", "ffmpeg");
const resourcesPath = path.join(__dirname, "..", "resources");

// 确保资源目录存在
if (!fs.existsSync(resourcesPath)) {
  fs.mkdirSync(resourcesPath, { recursive: true });
}

// 复制 FFmpeg 可执行文件
const ffmpegSource = path.join(vcpkgPath, "ffmpeg.exe");
const ffmpegDest = path.join(resourcesPath, "ffmpeg.exe");

if (fs.existsSync(ffmpegSource)) {
  fs.copyFileSync(ffmpegSource, ffmpegDest);
  console.log("✅ FFmpeg copied successfully");
} else {
  console.error("❌ FFmpeg not found in vcpkg installation");
  console.error(`Expected path: ${ffmpegSource}`);
}
```

## 步骤 4：更新 FFmpegAudioDecodeService

修改 `electron/main/services/FFmpegAudioDecodeService.ts`，优先使用 vcpkg 安装的 FFmpeg：

```typescript
private async findFFmpeg(): Promise<string | null> {
  const { access } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { useStore } = await import("../store");
  const store = useStore();
  const customFFmpegPath = store.get("ffmpegPath") as string | undefined;

  if (customFFmpegPath && customFFmpegPath.trim()) {
    try {
      await access(customFFmpegPath);
      return customFFmpegPath;
    } catch {
      ipcLog.warn(`Custom FFmpeg path not found: ${customFFmpegPath}`);
    }
  }

  // 优先使用 vcpkg 安装的 FFmpeg
  const vcpkgFFmpegPath = join(
    process.env.USERPROFILE || "",
    "vcpkg",
    "installed",
    "x64-windows",
    "tools",
    "ffmpeg",
    "ffmpeg.exe"
  );

  try {
    await access(vcpkgFFmpegPath);
    const result = await this.testFFmpegCommand(vcpkgFFmpegPath);
    if (result) {
      ipcLog.info(`[FFmpegDecode] ✅ FFmpeg found in vcpkg: ${vcpkgFFmpegPath}`);
      return vcpkgFFmpegPath;
    }
  } catch {
    ipcLog.info(`[FFmpegDecode] vcpkg FFmpeg not found: ${vcpkgFFmpegPath}`);
  }

  // 检查系统 PATH 中的 ffmpeg
  const systemPaths = process.platform === "win32"
    ? ["ffmpeg.exe", "ffmpeg"]
    : ["ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"];

  for (const cmd of systemPaths) {
    try {
      const result = await this.testFFmpegCommand(cmd);
      if (result) {
        return cmd;
      }
    } catch {
      continue;
    }
  }

  // 检查常见的安装位置
  const commonPaths = process.platform === "win32"
    ? [
        join(process.env.PROGRAMFILES || "C:\\Program Files", "ffmpeg", "bin", "ffmpeg.exe"),
        join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "ffmpeg", "bin", "ffmpeg.exe"),
        join(process.env.LOCALAPPDATA || process.env.USERPROFILE || "", "ffmpeg", "bin", "ffmpeg.exe"),
      ]
    : ["/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"];

  for (const path of commonPaths) {
    try {
      await access(path);
      const result = await this.testFFmpegCommand(path);
      if (result) {
        return path;
      }
    } catch {
      continue;
    }
  }

  ipcLog.error("[FFmpegDecode] ❌ FFmpeg not found");
  return null;
}
```

## 步骤 5：测试集成

### 5.1 验证 FFmpeg 可用性

```powershell
# 测试 vcpkg 安装的 FFmpeg
& "$env:USERPROFILE\vcpkg\installed\x64-windows\tools\ffmpeg\ffmpeg.exe" -version
```

### 5.2 运行项目

```powershell
# 在项目目录下
pnpm dev
```

### 5.3 测试 FFmpeg 解码功能

1. 打开应用程序
2. 播放一个需要 FFmpeg 解码的音频文件（如 DTS、APE 等）
3. 检查控制台日志，确认使用了 vcpkg 安装的 FFmpeg

## 常见问题

### Q1: vcpkg 安装失败

**解决方案：**

- 确保已安装 Visual Studio 2019 或更高版本
- 确保已安装 Git
- 尝试使用管理员权限运行 PowerShell

### Q2: FFmpeg 编译时间过长

**解决方案：**

- 使用预编译的二进制包：`vcpkg install ffmpeg:x64-windows --binarysource=default`
- 或者使用 `vcpkg install ffmpeg:x64-windows --recurse` 加速依赖安装

### Q3: 找不到 FFmpeg 可执行文件

**解决方案：**

- 检查 vcpkg 安装路径是否正确
- 确认 FFmpeg 已成功安装：`vcpkg list ffmpeg`
- 手动复制 FFmpeg 可执行文件到项目资源目录

### Q4: Electron 构建失败

**解决方案：**

- 确保 FFmpeg 可执行文件已复制到正确的位置
- 检查 `electron-builder.yml` 中的文件包含配置
- 使用 `pnpm build` 重新构建

## 优势

使用 vcpkg 安装 FFmpeg 的优势：

1. **版本管理**：vcpkg 自动管理 FFmpeg 及其依赖的版本
2. **跨平台**：支持 Windows、Linux、macOS
3. **一致性**：所有开发者使用相同版本的 FFmpeg
4. **自动化**：可以集成到 CI/CD 流程中
5. **可移植性**：FFmpeg 随应用一起分发，不依赖系统环境

## 下一步

完成集成后：

1. 测试所有支持的音频格式
2. 优化 FFmpeg 参数以提高性能
3. 添加错误处理和日志记录
4. 更新用户文档

## 参考资料

- [vcpkg 官方文档](https://vcpkg.io/)
- [FFmpeg vcpkg 端口](https://github.com/microsoft/vcpkg/tree/master/ports/ffmpeg)
- [Electron 打包指南](https://www.electron.build/)
