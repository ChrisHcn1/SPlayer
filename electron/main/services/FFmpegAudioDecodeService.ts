import { spawn, ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { join, extname } from "node:path";
import { ipcLog } from "../logger";
import { useStore } from "../store";

/**
 * FFmpeg 音频解码服务
 *
 * 用于实时解码原生不支持的音频格式（如 DTS、APE、DSD 等）
 * 将音频实时解码为 PCM 数据，供播放器使用
 */

interface DecodeOptions {
  /** 音频文件路径 */
  sourcePath: string;
  /** 输出格式，默认为 s16le (16-bit PCM) */
  sampleFormat?: "s16le" | "s32le" | "f32le";
  /** 采样率，默认为 48000 */
  sampleRate?: number;
  /** 声道数，默认为 2 (立体声) */
  channels?: number;
}

interface DecodeStream {
  /** FFmpeg 进程 */
  process: ChildProcess;
  /** 音频元数据 */
  metadata: {
    duration: number;
    sampleRate: number;
    channels: number;
    bitDepth: number;
  };
  /** 读取 PCM 数据的流 */
  pcmStream: NodeJS.ReadableStream;
}

class FFmpegAudioDecodeService {
  private ffmpegPath: string | null = null;
  private ffmpegChecked = false;

  /**
   * 检查 FFmpeg 是否可用
   */
  private async checkFFmpeg(): Promise<boolean> {
    if (this.ffmpegChecked) {
      return this.ffmpegPath !== null;
    }

    this.ffmpegChecked = true;
    ipcLog.info("[FFmpegDecode] Checking FFmpeg availability...");

    // 优先检查用户设置的 FFmpeg 路径
    const store = useStore();
    const customFFmpegPath = store.get("ffmpegPath") as string | undefined;

    if (customFFmpegPath?.trim()) {
      try {
        const result = await this.testFFmpegCommand(customFFmpegPath);
        if (result) {
          this.ffmpegPath = customFFmpegPath;
          ipcLog.info(`[FFmpegDecode] ✅ FFmpeg found at: ${customFFmpegPath}`);
          return true;
        }
      } catch (error) {
        ipcLog.warn(`[FFmpegDecode] ❌ Custom FFmpeg path failed: ${error}`);
      }
    }

    // 优先使用 vcpkg 安装的 FFmpeg
    const vcpkgFFmpegPath =
      process.platform === "win32"
        ? join(
            process.env.USERPROFILE || "",
            "vcpkg",
            "installed",
            "x64-windows",
            "tools",
            "ffmpeg",
            "ffmpeg.exe",
          )
        : join(
            process.env.HOME || "",
            "vcpkg",
            "installed",
            "x64-linux",
            "tools",
            "ffmpeg",
            "ffmpeg",
          );

    try {
      await access(vcpkgFFmpegPath);
      const result = await this.testFFmpegCommand(vcpkgFFmpegPath);
      if (result) {
        this.ffmpegPath = vcpkgFFmpegPath;
        ipcLog.info(`[FFmpegDecode] ✅ FFmpeg found in vcpkg: ${vcpkgFFmpegPath}`);
        return true;
      }
    } catch {
      ipcLog.info(`[FFmpegDecode] vcpkg FFmpeg not found: ${vcpkgFFmpegPath}`);
    }

    // 检查系统 PATH 中的 ffmpeg
    const systemPaths =
      process.platform === "win32"
        ? ["ffmpeg.exe", "ffmpeg"]
        : ["ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"];

    for (const cmd of systemPaths) {
      try {
        const result = await this.testFFmpegCommand(cmd);
        if (result) {
          this.ffmpegPath = cmd;
          ipcLog.info(`[FFmpegDecode] ✅ FFmpeg found in PATH: ${cmd}`);
          return true;
        }
      } catch {
        continue;
      }
    }

    // 检查常见的安装位置
    const commonPaths =
      process.platform === "win32"
        ? [
            join(process.env.PROGRAMFILES || "C:\\Program Files", "ffmpeg", "bin", "ffmpeg.exe"),
            join(
              process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
              "ffmpeg",
              "bin",
              "ffmpeg.exe",
            ),
            join(
              process.env.LOCALAPPDATA || process.env.USERPROFILE || "",
              "ffmpeg",
              "bin",
              "ffmpeg.exe",
            ),
          ]
        : ["/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"];

    for (const path of commonPaths) {
      try {
        await access(path);
        const result = await this.testFFmpegCommand(path);
        if (result) {
          this.ffmpegPath = path;
          ipcLog.info(`[FFmpegDecode] ✅ FFmpeg found at: ${path}`);
          return true;
        }
      } catch {
        continue;
      }
    }

    // 检查项目内置的FFmpeg
    const builtinPaths = [
      // 开发环境路径
      join(process.cwd(), "ffmpeg", "bin", "ffmpeg.exe"),
      join(process.cwd(), "ffmpeg", "ffmpeg.exe"),
      join(__dirname, "..", "..", "ffmpeg", "bin", "ffmpeg.exe"),
      join(__dirname, "..", "..", "ffmpeg", "ffmpeg.exe"),
      // 打包环境路径
      join(process.resourcesPath, "ffmpeg", "bin", "ffmpeg.exe"),
      join(process.resourcesPath, "ffmpeg", "ffmpeg.exe")
    ];

    ipcLog.info(`[FFmpegDecode] Checking ${builtinPaths.length} built-in FFmpeg paths`);

    for (const path of builtinPaths) {
      ipcLog.info(`[FFmpegDecode] Checking built-in path: ${path}`);
      try {
        await access(path);
        const result = await this.testFFmpegCommand(path);
        if (result) {
          this.ffmpegPath = path;
          ipcLog.info(`[FFmpegDecode] ✅ Built-in FFmpeg found at: ${path}`);
          return true;
        }
      } catch {
        ipcLog.info(`[FFmpegDecode] ❌ Built-in FFmpeg not found at: ${path}`);
        continue;
      }
    }

    ipcLog.error("[FFmpegDecode] ❌ FFmpeg not found");
    return false;
  }

  /**
   * 测试 FFmpeg 命令是否可用
   */
  private async testFFmpegCommand(ffmpegPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const ffmpegProcess = spawn(ffmpegPath, ["-version"], {
        shell: process.platform === "win32",
      });
      ffmpegProcess.on("close", (code) => {
        resolve(code === 0);
      });
      ffmpegProcess.on("error", () => {
        resolve(false);
      });
    });
  }

  /**
   * 获取音频文件的元数据
   */
  async getMetadata(sourcePath: string): Promise<{
    duration: number;
    sampleRate: number;
    channels: number;
    bitDepth: number;
    format: string;
    bitrate: number;
    codec: string;
    sampleFormat: string;
    averageBitrate: number;
  } | null> {
    if (!(await this.checkFFmpeg())) {
      throw new Error("FFmpeg not found");
    }

    return new Promise((resolve, reject) => {
      const args = ["-i", sourcePath, "-f", "ffmetadata", "-"];

      const ffmpegProcess = spawn(this.ffmpegPath!, args, { shell: process.platform === "win32" });
      let stderr = "";
      let _stdout = "";

      ffmpegProcess.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      ffmpegProcess.stdout.on("data", (data) => {
        _stdout += data.toString();
      });

      ffmpegProcess.on("close", () => {
        // 从 stderr 中解析元数据
        const durationMatch = stderr.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
        const streamMatch = stderr.match(
          /Stream #0:\d+: Audio: ([^,]+), (\d+) Hz, ([^,]+), ([^,\s]+)/,
        );

        if (durationMatch && streamMatch) {
          const hours = parseInt(durationMatch[1]);
          const minutes = parseInt(durationMatch[2]);
          const seconds = parseFloat(durationMatch[3]);
          const duration = hours * 3600 + minutes * 60 + seconds;

          // 尝试从streamMatch中提取位深度
          let bitDepth = 16; // 默认 16-bit
          const bitDepthMatch = stderr.match(/bits:(\d+)/i);
          if (bitDepthMatch) {
            bitDepth = parseInt(bitDepthMatch[1]);
          }

          // 尝试更准确地解析声道数
          let channels = 2; // 默认立体声
          const channelsMatch = streamMatch[3].match(/(\d+)\s*channels?/i);
          if (channelsMatch) {
            channels = parseInt(channelsMatch[1]);
          } else if (streamMatch[3].includes("mono")) {
            channels = 1;
          } else if (streamMatch[3].includes("stereo")) {
            channels = 2;
          }

          // 提取比特率
          let bitrate = 0;
          const bitrateMatch = stderr.match(/(\d+)\s*kb\/s/i);
          if (bitrateMatch) {
            bitrate = parseInt(bitrateMatch[1]);
          }

          // 提取编码格式
          const codec = streamMatch[1].trim();

          // 提取样本格式
          let sampleFormat = "s16";
          const sampleFormatMatch = stderr.match(/sample_fmt:\s*(\w+)/i);
          if (sampleFormatMatch) {
            sampleFormat = sampleFormatMatch[1];
          }

          // 计算平均比特率
          const sampleRate = parseInt(streamMatch[2]);
          const averageBitrate = (sampleRate * channels * bitDepth) / 1000;

          resolve({
            duration,
            sampleRate,
            channels,
            bitDepth,
            format: streamMatch[1].trim(),
            bitrate,
            codec,
            sampleFormat,
            averageBitrate,
          });
        } else {
          resolve(null);
        }
      });

      ffmpegProcess.on("error", (error) => {
        reject(error);
      });
    });
  }

  /**
   * 开始解码音频文件
   * 将音频实时解码为 PCM 数据流
   */
  async startDecode(options: DecodeOptions): Promise<DecodeStream> {
    if (!(await this.checkFFmpeg())) {
      throw new Error("FFmpeg not found");
    }

    const { sourcePath, sampleFormat = "s16le" } = options;

    // 首先获取元数据
    const metadata = await this.getMetadata(sourcePath);
    if (!metadata) {
      throw new Error("Failed to get audio metadata");
    }

    // 使用元数据中的参数，确保音频质量
    const sampleRate = metadata.sampleRate;
    const channels = metadata.channels;

    // 构建 FFmpeg 命令
    const args = [
      "-i",
      sourcePath,
      "-f",
      sampleFormat,
      "-ar",
      sampleRate.toString(),
      "-ac",
      channels.toString(),
      "-vn", // 禁用视频
      "-", // 输出到 stdout
    ];

    ipcLog.info(`[FFmpegDecode] Starting decode: ${sourcePath}`);
    ipcLog.info(`[FFmpegDecode] Command: ${this.ffmpegPath} ${args.join(" ")}`);

    const ffmpegProcess = spawn(this.ffmpegPath!, args, {
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    ffmpegProcess.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffmpegProcess.on("close", (code) => {
      if (code !== 0) {
        ipcLog.error(`[FFmpegDecode] FFmpeg exited with code ${code}: ${stderr}`);
      } else {
        ipcLog.info(`[FFmpegDecode] FFmpeg completed successfully`);
      }
    });

    ffmpegProcess.on("error", (error) => {
      ipcLog.error(`[FFmpegDecode] FFmpeg process error:`, error);
    });

    return {
      process: ffmpegProcess,
      metadata,
      pcmStream: ffmpegProcess.stdout!,
    };
  }

  /**
   * 停止解码
   */
  stopDecode(stream: DecodeStream): void {
    if (stream.process && !stream.process.killed) {
      stream.process.kill("SIGTERM");
      ipcLog.info("[FFmpegDecode] Decode stopped");
    }
  }

  /**
   * 检查音频格式是否需要 FFmpeg 解码
   */
  static needsFFmpegDecode(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase();
    const formatsNeedingFFmpeg = [
      ".dts", // DTS 音频
      ".ape", // Monkey's Audio
      ".dsf", // DSD 音频
      ".dff", // DSD 音频
      ".wv", // WavPack
      ".tak", // TAK 音频
      ".mlp", // Meridian Lossless Packing
      ".thd", // TrueHD
    ];
    return formatsNeedingFFmpeg.includes(ext);
  }
}

export const ffmpegAudioDecodeService = new FFmpegAudioDecodeService();
export default FFmpegAudioDecodeService;
