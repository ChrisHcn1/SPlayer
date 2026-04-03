# SPlayer

一个极简风格的音乐播放器，支持本地音乐、网络音乐和流媒体服务。

## 技术栈

- **核心框架**: Vue 3 + Electron
- **UI 组件库**: Naive UI
- **包管理器**: pnpm
- **构建工具**: electron-vite

## 开发环境设置

### 1. 克隆项目

```bash
git clone https://github.com/imsyy/SPlayer.git
cd SPlayer
```

### 2. 安装依赖

```bash
pnpm install
```

### 3. 安装 FFmpeg

项目需要 FFmpeg 来支持 DSD、APE、DTS 等无损音频格式的播放。

#### 方法一：使用系统 FFmpeg

确保系统环境变量中包含 FFmpeg 的路径。

#### 方法二：使用内置 FFmpeg

1. 下载 FFmpeg 可执行文件（推荐版本：6.0+）
2. 创建 `ffmpeg/bin` 目录
3. 将 `ffmpeg.exe`、`ffplay.exe`、`ffprobe.exe` 及其依赖的 DLL 文件放入该目录

## 开发命令

- **开发模式**: `pnpm dev`
- **构建项目**: `pnpm build`
- **代码格式化**: `pnpm format`
- **代码质量检查**: `pnpm lint`
- **类型检查**: `pnpm typecheck`

## 项目结构

```
SPlayer/
├── electron/         # Electron 主进程代码
├── src/              # 渲染进程代码
├── scripts/          # 构建脚本
├── public/           # 静态资源
├── ffmpeg/           # FFmpeg 可执行文件（本地开发用）
└── resources/        # 资源文件
```

## 功能特性

- 🎵 支持本地音乐播放
- 📡 支持网络音乐和流媒体服务
- 🎧 支持 DSD、APE、DTS 等无损音频格式
- 🎨 极简风格 UI
- 📱 响应式设计，支持移动设备
- 🌙 深色模式
- 🎸 音频可视化
- 📃 歌词显示

## 许可证

AGPL-3.0

## 贡献

欢迎提交 Issue 和 Pull Request！

## 致谢

- [Vue 3](https://vuejs.org/)
- [Electron](https://www.electronjs.org/)
- [Naive UI](https://www.naiveui.com/)
- [FFmpeg](https://ffmpeg.org/)
- [@ffmpeg/ffmpeg](https://github.com/ffmpegwasm/ffmpeg.wasm)

## 作者

- [imsyy](https://imsyy.top)
- [GitHub](https://github.com/imsyy)