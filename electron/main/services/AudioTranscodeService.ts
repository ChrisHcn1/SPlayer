import { spawn, ChildProcess } from "node:child_process";
import { access, mkdir, stat, unlink } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { ipcLog } from "../logger";
import { useStore } from "../store";

type TranscodeStatus = "pending" | "transcoding" | "completed" | "failed";

interface TranscodeJob {
  sourcePath: string;
  targetPath: string;
  format: string;
  status: TranscodeStatus;
  progress: number;
  error?: string;
  process?: ChildProcess;
}

class AudioTranscodeService {
  private jobs: Map<string, TranscodeJob> = new Map();
  private ffmpegPath: string | null = null;
  private ffmpegChecked = false;

  private getCacheDir(): string {
    const store = useStore();
    const cachePath = store.get("cachePath");
    return join(cachePath, "transcoded-audio");
  }

  private async ensureCacheDir(): Promise<void> {
    const cacheDir = this.getCacheDir();
    try {
      await access(cacheDir);
    } catch {
      await mkdir(cacheDir, { recursive: true });
    }
  }

  private async checkFFmpeg(): Promise<boolean> {
    if (this.ffmpegChecked) {
      ipcLog.info(`[AudioTranscode] FFmpeg already checked, path: ${this.ffmpegPath}`);
      return this.ffmpegPath !== null;
    }

    this.ffmpegChecked = true;
    ipcLog.info("[AudioTranscode] Checking FFmpeg availability...");

    // 优先检查用户设置的 FFmpeg 路径
    const store = useStore();
    const customFFmpegPath = store.get("ffmpegPath") as string | undefined;

    if (customFFmpegPath && customFFmpegPath.trim()) {
      ipcLog.info(`[AudioTranscode] Checking user-specified FFmpeg path: ${customFFmpegPath}`);
      try {
        const result = await this.testFFmpegCommand(customFFmpegPath);
        if (result) {
          this.ffmpegPath = customFFmpegPath;
          ipcLog.info(
            `[AudioTranscode] ✅ FFmpeg found at user-specified path: ${customFFmpegPath}`,
          );
          return true;
        }
      } catch (error) {
        ipcLog.warn(`[AudioTranscode] ❌ User-specified FFmpeg path failed: ${error}`);
      }
    }

    // 优先使用系统环境变量 PATH 中的 ffmpeg
    const systemPaths =
      process.platform === "win32"
        ? ["ffmpeg.exe", "ffmpeg"]
        : ["ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"];

    // 检查系统 PATH 中的 ffmpeg
    for (const cmd of systemPaths) {
      ipcLog.info(`[AudioTranscode] Checking system PATH for: ${cmd}`);
      try {
        const result = await this.testFFmpegCommand(cmd);
        if (result) {
          this.ffmpegPath = cmd;
          ipcLog.info(`[AudioTranscode] ✅ FFmpeg found in system PATH: ${cmd}`);
          return true;
        }
      } catch {
        ipcLog.info(`[AudioTranscode] ❌ FFmpeg not found in PATH: ${cmd}`);
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

    ipcLog.info(`[AudioTranscode] Checking ${commonPaths.length} common installation paths`);

    for (const path of commonPaths) {
      ipcLog.info(`[AudioTranscode] Checking path: ${path}`);
      try {
        await access(path);
        const result = await this.testFFmpegCommand(path);
        if (result) {
          this.ffmpegPath = path;
          ipcLog.info(`[AudioTranscode] ✅ FFmpeg found at: ${path}`);
          return true;
        }
      } catch {
        ipcLog.info(`[AudioTranscode] ❌ FFmpeg not found at: ${path}`);
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
      join(process.resourcesPath, "ffmpeg", "ffmpeg.exe"),
    ];

    ipcLog.info(`[AudioTranscode] Checking ${builtinPaths.length} built-in FFmpeg paths`);

    for (const path of builtinPaths) {
      ipcLog.info(`[AudioTranscode] Checking built-in path: ${path}`);
      try {
        await access(path);
        const result = await this.testFFmpegCommand(path);
        if (result) {
          this.ffmpegPath = path;
          ipcLog.info(`[AudioTranscode] ✅ Built-in FFmpeg found at: ${path}`);
          return true;
        }
      } catch {
        ipcLog.info(`[AudioTranscode] ❌ Built-in FFmpeg not found at: ${path}`);
        continue;
      }
    }

    ipcLog.warn(
      "[AudioTranscode] ⚠️ FFmpeg not found in user-specified path, system PATH, common installation paths, or built-in paths",
    );
    ipcLog.warn(
      "[AudioTranscode] 💡 Please configure FFmpeg path in settings or add it to your system PATH",
    );
    ipcLog.warn("[AudioTranscode] 💡 Download from: https://ffmpeg.org/download.html");
    return false;
  }

  private async testFFmpegCommand(command: string): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(command, ["-version"], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      });

      let output = "";
      child.stdout.on("data", (data: Buffer) => {
        output += data.toString();
      });

      child.on("close", (code: number) => {
        if (code === 0 && output.includes("ffmpeg version")) {
          resolve(true);
        } else {
          resolve(false);
        }
      });

      child.on("error", () => {
        resolve(false);
      });
    });
  }

  private getTargetPath(sourcePath: string, targetFormat: string): string {
    const cacheDir = this.getCacheDir();
    const fileName = basename(sourcePath, extname(sourcePath));
    const targetFileName = `${fileName}.${targetFormat}`;
    return join(cacheDir, targetFileName);
  }

  private async needsTranscode(sourcePath: string, targetFormat: string): Promise<boolean> {
    const targetPath = this.getTargetPath(sourcePath, targetFormat);

    try {
      const sourceStat = await stat(sourcePath);
      const targetStat = await stat(targetPath);

      return targetStat.mtime < sourceStat.mtime;
    } catch {
      return true;
    }
  }

  public async isFFmpegAvailable(): Promise<boolean> {
    return await this.checkFFmpeg();
  }

  public async transcodeAudio(
    sourcePath: string,
    targetFormat: string = "flac",
    onProgress?: (progress: number) => void,
  ): Promise<{ success: boolean; targetPath?: string; error?: string }> {
    if (!(await this.checkFFmpeg())) {
      return { success: false, error: "FFmpeg not available" };
    }

    await this.ensureCacheDir();

    const targetPath = this.getTargetPath(sourcePath, targetFormat);

    if (!(await this.needsTranscode(sourcePath, targetFormat))) {
      ipcLog.info(`[AudioTranscode] Using cached transcoded file: ${targetPath}`);
      return { success: true, targetPath };
    }

    const jobId = `${sourcePath}:${targetFormat}`;
    const existingJob = this.jobs.get(jobId);

    if (existingJob && existingJob.status === "transcoding") {
      ipcLog.info(`[AudioTranscode] Transcoding already in progress: ${jobId}`);
      return { success: false, error: "Transcoding in progress" };
    }

    return new Promise((resolve) => {
      const job: TranscodeJob = {
        sourcePath,
        targetPath,
        format: targetFormat,
        status: "transcoding",
        progress: 0,
      };

      this.jobs.set(jobId, job);

      const args = [
        "-i",
        sourcePath,
        "-c:a",
        targetFormat === "flac" ? "flac" : "pcm_s16le",
        "-y",
        targetPath,
      ];

      ipcLog.info(`[AudioTranscode] Starting transcoding: ${sourcePath} -> ${targetPath}`);

      const ffmpegProcess = spawn(this.ffmpegPath!, args);

      job.process = ffmpegProcess;

      let stderrData = "";

      ffmpegProcess.stderr?.on("data", (data) => {
        stderrData += data.toString();

        const durationMatch = stderrData.match(/Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
        const timeMatch = stderrData.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);

        if (durationMatch && timeMatch) {
          const duration =
            parseInt(durationMatch[1]) * 3600 +
            parseInt(durationMatch[2]) * 60 +
            parseInt(durationMatch[3]) +
            parseInt(durationMatch[4]) / 100;

          const currentTime =
            parseInt(timeMatch[1]) * 3600 +
            parseInt(timeMatch[2]) * 60 +
            parseInt(timeMatch[3]) +
            parseInt(timeMatch[4]) / 100;

          if (duration > 0) {
            const progress = Math.min(100, (currentTime / duration) * 100);
            job.progress = progress;
            onProgress?.(progress);
          }
        }
      });

      ffmpegProcess.on("close", async (code) => {
        if (code === 0) {
          job.status = "completed";
          job.progress = 100;
          ipcLog.info(`[AudioTranscode] Transcoding completed: ${targetPath}`);
          resolve({ success: true, targetPath });
        } else {
          job.status = "failed";
          job.error = `FFmpeg exited with code ${code}`;
          ipcLog.error(`[AudioTranscode] Transcoding failed: ${job.error}`);

          try {
            await unlink(targetPath);
          } catch {
            void 0;
          }

          resolve({ success: false, error: job.error });
        }

        this.jobs.delete(jobId);
      });

      ffmpegProcess.on("error", (err) => {
        job.status = "failed";
        job.error = err.message;
        ipcLog.error(`[AudioTranscode] FFmpeg error: ${err.message}`);
        resolve({ success: false, error: err.message });
        this.jobs.delete(jobId);
      });
    });
  }

  public getJobStatus(sourcePath: string, targetFormat: string): TranscodeJob | undefined {
    const jobId = `${sourcePath}:${targetFormat}`;
    return this.jobs.get(jobId);
  }

  public cancelTranscode(sourcePath: string, targetFormat: string): boolean {
    const jobId = `${sourcePath}:${targetFormat}`;
    const job = this.jobs.get(jobId);

    if (job && job.process) {
      job.process.kill();
      job.status = "failed";
      job.error = "Cancelled";
      this.jobs.delete(jobId);
      return true;
    }

    return false;
  }

  public async cleanupCache(olderThanMs: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    const cacheDir = this.getCacheDir();
    let deletedCount = 0;
    const now = Date.now();

    try {
      const fs = await import("node:fs/promises");
      const entries = await fs.readdir(cacheDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isFile()) {
          const filePath = join(cacheDir, entry.name);
          const stats = await stat(filePath);

          if (now - stats.mtimeMs > olderThanMs) {
            await unlink(filePath);
            deletedCount++;
            ipcLog.info(`[AudioTranscode] Cleaned up old cache: ${filePath}`);
          }
        }
      }
    } catch (error) {
      ipcLog.error("[AudioTranscode] Cache cleanup error:", error);
    }

    return deletedCount;
  }
}

const audioTranscodeService = new AudioTranscodeService();

export default audioTranscodeService;
