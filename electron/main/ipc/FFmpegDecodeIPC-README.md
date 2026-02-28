# FFmpeg 音频解码 IPC 接口文档

本文档描述了用于实时音频解码的 IPC 接口，这些接口用于播放原生不支持的音频格式（如 DTS、APE、DSD 等）。

## 接口列表

### 1. ffmpeg-decode:needs-decode

检查音频文件是否需要使用 FFmpeg 进行解码。

**请求参数：**
- `filePath` (string) - 音频文件路径

**返回值：**
- `boolean` - `true` 表示需要 FFmpeg 解码，`false` 表示不需要

**使用示例：**
```typescript
const result = await window.electron.ipcRenderer.invoke("ffmpeg-decode:needs-decode", "/path/to/audio.dts");
if (result) {
  console.log("需要使用 FFmpeg 解码");
} else {
  console.log("可以使用原生播放器");
}
```

**支持的格式：**
- `.dts` - DTS 音频
- `.ape` - Monkey's Audio
- `.dsf` - DSD 音频
- `.dff` - DSD 音频
- `.wv` - WavPack
- `.tak` - TAK 音频
- `.mlp` - Meridian Lossless Packing
- `.thd` - TrueHD

---

### 2. ffmpeg-decode:get-metadata

获取音频文件的元数据信息。

**请求参数：**
- `filePath` (string) - 音频文件路径

**返回值：**
```typescript
{
  success: boolean,  // 是否成功获取
  metadata?: {
    duration: number,      // 音频时长（秒）
    sampleRate: number,    // 采样率（如 48000）
    channels: number,     // 声道数（如 2 表示立体声）
    bitDepth: number,     // 位深度（如 16）
    format: string,       // 音频格式名称
  },
  error?: string  // 错误信息（如果失败）
}
```

**使用示例：**
```typescript
const result = await window.electron.ipcRenderer.invoke("ffmpeg-decode:get-metadata", "/path/to/audio.dts");
if (result.success && result.metadata) {
  console.log(`时长: ${result.metadata.duration} 秒`);
  console.log(`采样率: ${result.metadata.sampleRate} Hz`);
  console.log(`声道数: ${result.metadata.channels}`);
}
```

---

### 3. ffmpeg-decode:start

开始音频解码，创建一个解码会话。

**请求参数：**
- `filePath` (string) - 音频文件路径

**返回值：**
```typescript
{
  success: boolean,      // 是否成功启动解码
  decodeId: string,     // 解码会话 ID，用于后续操作
  metadata?: {
    duration: number,      // 音频时长（秒）
    sampleRate: number,    // 采样率
    channels: number,     // 声道数
    bitDepth: number,     // 位深度
  },
  error?: string  // 错误信息（如果失败）
}
```

**使用示例：**
```typescript
const result = await window.electron.ipcRenderer.invoke("ffmpeg-decode:start", "/path/to/audio.dts");
if (result.success) {
  const decodeId = result.decodeId;
  console.log(`解码已启动，会话 ID: ${decodeId}`);
  console.log(`音频时长: ${result.metadata?.duration} 秒`);
}
```

**解码参数：**
- 采样格式：`s16le` (16-bit PCM, little-endian)
- 采样率：`48000` Hz
- 声道数：`2` (立体声)

---

### 4. ffmpeg-decode:read

读取解码后的 PCM 数据。

**请求参数：**
- `decodeId` (string) - 解码会话 ID（从 `ffmpeg-decode:start` 获取）
- `chunkSize` (number, 可选) - 每次读取的字节数，默认 `65536` (64KB)

**返回值：**
```typescript
{
  success: boolean,  // 是否成功读取
  data?: string,    // PCM 数据的 Base64 编码
  done: boolean,    // 解码是否已完成（`true` 表示没有更多数据）
  error?: string  // 错误信息（如果失败）
}
```

**使用示例：**
```typescript
// 读取 PCM 数据
const result = await window.electron.ipcRenderer.invoke(
  "ffmpeg-decode:read",
  decodeId,
  65536
);

if (result.success && result.data) {
  const pcmData = Buffer.from(result.data, "base64");
  console.log(`读取到 ${pcmData.length} 字节 PCM 数据`);
  
  if (result.done) {
    console.log("解码已完成");
  }
}
```

**数据格式：**
- PCM 格式：16-bit signed integer, little-endian
- 声道顺序：交错存储（LRLRLRL...）
- 数据编码：Base64 字符串

---

### 5. ffmpeg-decode:stop

停止正在进行的解码会话。

**请求参数：**
- `decodeId` (string) - 解码会话 ID

**返回值：**
```typescript
{
  success: boolean,  // 是否成功停止
  error?: string  // 错误信息（如果失败）
}
```

**使用示例：**
```typescript
const result = await window.electron.ipcRenderer.invoke("ffmpeg-decode:stop", decodeId);
if (result.success) {
  console.log("解码已停止");
}
```

---

### 6. ffmpeg-decode:cleanup

清理所有活跃的解码会话，释放系统资源。

**请求参数：**
- 无

**返回值：**
```typescript
{
  success: boolean,  // 是否成功清理
  error?: string  // 错误信息（如果失败）
}
```

**使用示例：**
```typescript
const result = await window.electron.ipcRenderer.invoke("ffmpeg-decode:cleanup");
if (result.success) {
  console.log("所有解码会话已清理");
}
```

---

## 完整使用流程

### 播放音频文件的完整流程

```typescript
async function playAudioFile(filePath: string) {
  // 1. 检查是否需要 FFmpeg 解码
  const needsDecode = await window.electron.ipcRenderer.invoke(
    "ffmpeg-decode:needs-decode",
    filePath
  );

  if (!needsDecode) {
    // 使用原生播放器
    console.log("使用原生播放器播放");
    return;
  }

  // 2. 获取音频元数据
  const metadataResult = await window.electron.ipcRenderer.invoke(
    "ffmpeg-decode:get-metadata",
    filePath
  );

  if (!metadataResult.success) {
    console.error("获取元数据失败:", metadataResult.error);
    return;
  }

  const metadata = metadataResult.metadata;
  console.log(`音频时长: ${metadata.duration} 秒`);
  console.log(`采样率: ${metadata.sampleRate} Hz`);

  // 3. 开始解码
  const decodeResult = await window.electron.ipcRenderer.invoke(
    "ffmpeg-decode:start",
    filePath
  );

  if (!decodeResult.success) {
    console.error("启动解码失败:", decodeResult.error);
    return;
  }

  const decodeId = decodeResult.decodeId;
  console.log(`解码已启动，会话 ID: ${decodeId}`);

  // 4. 创建 FFmpegBinaryPlayer 实例
  const player = new FFmpegBinaryPlayer();

  // 5. 加载音频文件
  await player.load(filePath, false);

  // 6. 播放
  await player.play();

  // 7. 读取 PCM 数据（在播放器内部自动处理）
  // FFmpegBinaryPlayer 会自动调用 ffmpeg-decode:read 接口

  // 8. 停止播放时
  await player.stop();
  // FFmpegBinaryPlayer 会自动调用 ffmpeg-decode:stop 接口

  // 9. 清理解码会话（可选）
  await window.electron.ipcRenderer.invoke("ffmpeg-decode:cleanup");
}
```

---

## 错误处理

### 常见错误及解决方案

1. **FFmpeg not found**
   - 错误信息：`FFmpeg not found`
   - 解决方案：安装 FFmpeg 或在设置中配置 FFmpeg 路径
   - 下载地址：https://ffmpeg.org/download.html

2. **Failed to get metadata**
   - 错误信息：`Failed to get audio metadata`
   - 可能原因：文件损坏或格式不支持
   - 解决方案：检查文件是否完整，尝试其他文件

3. **Decode session not found**
   - 错误信息：`Decode session not found`
   - 可能原因：解码会话已过期或被清理
   - 解决方案：重新启动解码

---

## 性能优化

### 缓冲区管理

- **高水位标记**：30 秒
- **低水位标记**：10 秒
- **读取策略**：
  - 当缓冲区低于低水位时，自动读取更多数据
  - 当缓冲区达到高水位时，暂停读取

### 内存管理

- **PCM 数据缓冲**：使用数组存储解码后的数据
- **会话管理**：使用 Map 存储活跃的解码会话
- **自动清理**：解码完成后自动清理资源

---

## 注意事项

1. **FFmpeg 路径配置**
   - 程序会自动查找系统 PATH 中的 FFmpeg
   - 也可以在设置中手动指定 FFmpeg 路径

2. **资源释放**
   - 播放停止时，解码会话会自动停止
   - 建议在应用退出时调用 `ffmpeg-decode:cleanup` 清理所有会话

3. **并发限制**
   - 每个文件只能有一个活跃的解码会话
   - 多次调用 `ffmpeg-decode:start` 会停止之前的会话

4. **数据格式**
   - 默认使用 16-bit PCM，little-endian
   - 立体声，采样率 48000 Hz
   - 如需其他格式，需要修改服务代码

---

## 技术支持

如有问题或需要帮助，请查看：
- 项目文档：README.md
- 问题反馈：GitHub Issues
