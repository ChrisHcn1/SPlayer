import { ipcLog } from "../logger";
import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";

interface FFplayProcess {
  process: ChildProcess;
  processId: number;
  filePath: string;
  startTime: number;
  isPaused: boolean;
  currentTime: number;
  duration: number;
  ended: boolean;
}

class FFplayAudioService {
  private ffplayPath: string;
  private processes: Map<number, FFplayProcess> = new Map();
  private nextProcessId = 1;

  constructor() {
    // 使用项目目录下的ffplay.exe
    // 尝试不同的路径
    const possiblePaths = [
      // 开发环境路径
      path.join(process.cwd(), "ffmpeg", "bin", "ffplay.exe"),
      path.join(process.cwd(), "ffmpeg", "ffplay.exe"),
      path.join(__dirname, "..", "..", "ffmpeg", "bin", "ffplay.exe"),
      path.join(__dirname, "..", "..", "ffmpeg", "ffplay.exe"),
      // 打包环境路径
      path.join(process.resourcesPath, "ffmpeg", "bin", "ffplay.exe"),
      path.join(process.resourcesPath, "ffmpeg", "ffplay.exe"),
    ];

    let foundPath: string | null = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        foundPath = p;
        break;
      }
    }

    if (foundPath) {
      this.ffplayPath = foundPath;
      ipcLog.info(`[FFplayAudioService] Found ffplay.exe at: ${this.ffplayPath}`);
    } else {
      // 默认使用第一个路径
      this.ffplayPath = possiblePaths[0];
      ipcLog.error(
        `[FFplayAudioService] ffplay.exe not found at any location: ${possiblePaths.join(", ")}`,
      );
    }
  }

  /**
   * 获取音频文件的元数据
   */
  async getMetadata(filePath: string): Promise<{
    sampleRate: number;
    channels: number;
    duration: number;
    title?: string;
    artist?: string;
    album?: string;
  }> {
    return new Promise((resolve, reject) => {
      try {
        const ffprobePath = path.join(path.dirname(this.ffplayPath), "ffprobe.exe");

        ipcLog.info(`[FFplayAudioService] Getting metadata for: ${filePath}`);
        ipcLog.info(`[FFplayAudioService] Using ffprobe at: ${ffprobePath}`);

        if (!fs.existsSync(ffprobePath)) {
          ipcLog.error(`[FFplayAudioService] ffprobe.exe not found at: ${ffprobePath}`);
          reject(new Error(`ffprobe.exe not found at: ${ffprobePath}`));
          return;
        }

        const args = [
          "-v",
          "error",
          "-select_streams",
          "a:0",
          "-show_entries",
          "stream=sample_rate,channels,duration:format=duration",
          "-show_entries",
          "format_tags=title,artist,album",
          "-of",
          "json",
          filePath,
        ];

        ipcLog.info(
          `[FFplayAudioService] Running ffprobe command: ${ffprobePath} ${args.join(" ")}`,
        );

        const ffprobeProcess = spawn(ffprobePath, args, {
          env: {
            ...process.env,
            FFPROBE_FORCE_UTF8: "1",
            LANG: "zh_CN.UTF-8",
            LC_ALL: "zh_CN.UTF-8",
          },
        });
        let output = "";
        let stderr = "";

        ffprobeProcess.stdout.on("data", (data) => {
          output += data.toString();
        });

        ffprobeProcess.stderr.on("data", (data) => {
          const errorMsg = data.toString();
          stderr += errorMsg;
          ipcLog.warn(`[FFplayAudioService] ffprobe stderr: ${errorMsg}`);
        });

        ffprobeProcess.on("close", (code) => {
          ipcLog.info(`[FFplayAudioService] ffprobe exited with code: ${code}`);
          ipcLog.info(`[FFplayAudioService] ffprobe output: ${output}`);
          if (stderr) {
            ipcLog.warn(`[FFplayAudioService] ffprobe full stderr: ${stderr}`);
          }

          if (code === 0) {
            try {
              const result = JSON.parse(output);
              const metadata: {
                sampleRate: number;
                channels: number;
                duration: number;
                title?: string;
                artist?: string;
                album?: string;
              } = {
                sampleRate: 44100,
                channels: 2,
                duration: 0,
              };

              if (result.streams && result.streams[0]) {
                const stream = result.streams[0];
                metadata.sampleRate = parseInt(stream.sample_rate || "44100");
                metadata.channels = parseInt(stream.channels || "2");
                metadata.duration = parseFloat(stream.duration || "0");
              }

              // 从format中获取时长（某些格式时长在format中）
              if (result.format && result.format.duration) {
                metadata.duration = parseFloat(result.format.duration);
              }

              // 获取标签信息
              if (result.format && result.format.tags) {
                const tags = result.format.tags;
                metadata.title = tags.title || tags.TITLE || tags.Title;
                metadata.artist = tags.artist || tags.ARTIST || tags.Artist;
                metadata.album = tags.album || tags.ALBUM || tags.Album;
              }

              ipcLog.info(
                `[FFplayAudioService] Metadata extracted successfully: ${JSON.stringify(metadata)}`,
              );
              resolve(metadata);
            } catch (error) {
              ipcLog.error(`[FFplayAudioService] JSON parse error: ${error}`);
              ipcLog.error(`[FFplayAudioService] Output that caused error: ${output}`);
              reject(error);
            }
          } else {
            const errorMsg = `ffprobe exited with code ${code}. Stderr: ${stderr}`;
            ipcLog.error(`[FFplayAudioService] ${errorMsg}`);
            reject(new Error(errorMsg));
          }
        });

        ffprobeProcess.on("error", (error) => {
          ipcLog.error(`[FFplayAudioService] ffprobe process error: ${error}`);
          reject(error);
        });
      } catch (error) {
        ipcLog.error(`[FFplayAudioService] getMetadata error: ${error}`);
        reject(error);
      }
    });
  }

  /**
   * 开始播放音频文件
   */
  async play(filePath: string, startTime: number = 0): Promise<{ processId: number }> {
    return new Promise((resolve, reject) => {
      try {
        if (!fs.existsSync(this.ffplayPath)) {
          reject(new Error(`ffplay.exe not found at: ${this.ffplayPath}`));
          return;
        }

        if (!fs.existsSync(filePath)) {
          reject(new Error(`File not found: ${filePath}`));
          return;
        }

        // 检查文件扩展名
        const ext = filePath.toLowerCase().split(".").pop();
        const isDsdFile = ["dsf", "dff"].includes(ext || "");

        // 无窗播放参数
        const args = [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nodisp", // 隐藏窗口
          "-autoexit", // 播放结束后自动退出
          "-ss",
          startTime.toString(), // 开始时间
          "-threads",
          "4",
        ];

        // 为DSD文件添加特殊参数
        if (isDsdFile) {
          // 确保DSD文件正确播放
          args.push("-af", "aformat=s16:44100");
        }

        args.push(filePath);

        const process = spawn(this.ffplayPath, args);
        const processId = this.nextProcessId++;

        const ffplayProcess: FFplayProcess = {
          process,
          processId,
          filePath,
          startTime,
          isPaused: false,
          currentTime: startTime,
          duration: 0,
          ended: false,
        };

        this.processes.set(processId, ffplayProcess);

        // 获取音频时长
        this.getMetadata(filePath)
          .then((metadata) => {
            ffplayProcess.duration = metadata.duration;
          })
          .catch(() => {
            // ignore
          });

        // 启动定时器更新当前时间
        const updateInterval = setInterval(() => {
          if (ffplayProcess.ended) {
            clearInterval(updateInterval);
            return;
          }
          if (!ffplayProcess.isPaused) {
            ffplayProcess.currentTime += 0.25; // 每250ms更新一次
          }
        }, 250);

        process.on("close", () => {
          clearInterval(updateInterval);
          ffplayProcess.ended = true;
          // 5秒后清理进程
          setTimeout(() => {
            this.processes.delete(processId);
          }, 5000);
        });

        process.on("error", (error) => {
          ipcLog.error(`[FFplayAudioService] ffplay error: ${error}`);
          this.processes.delete(processId);
        });

        resolve({ processId });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * 暂停播放
   */
  async pause(processId: number): Promise<void> {
    const process = this.processes.get(processId);
    if (process) {
      process.isPaused = true;
      // 发送暂停命令
      process.process.stdin?.write("p");
    }
  }

  /**
   * 恢复播放
   */
  async resume(processId: number): Promise<void> {
    const process = this.processes.get(processId);
    if (process) {
      process.isPaused = false;
      // 发送恢复命令
      process.process.stdin?.write("p");
    }
  }

  /**
   * 停止播放
   */
  async stop(processId: number): Promise<void> {
    const process = this.processes.get(processId);
    if (process) {
      process.ended = true;
      process.process.kill();
      this.processes.delete(processId);
    }
  }

  /**
   * 跳转到指定时间
   */
  async seek(processId: number, time: number): Promise<number> {
    const process = this.processes.get(processId);
    if (process) {
      const wasPaused = process.isPaused;
      const duration = process.duration;

      // 停止当前进程
      process.process.kill();
      this.processes.delete(processId);

      // 重新启动播放，使用新的进程ID
      const result = await this.play(process.filePath, time);

      // 更新新进程的属性
      const newProcess = this.processes.get(result.processId);
      if (newProcess) {
        newProcess.isPaused = wasPaused;
        newProcess.duration = duration;
      }

      return result.processId;
    }
    return processId;
  }

  /**
   * 设置播放速率
   */
  async setRate(processId: number, _rate: number): Promise<void> {
    const process = this.processes.get(processId);
    if (process) {
      // 发送速率调整命令
      // 注意：ffplay的速率调整可能需要特定的参数
      // 这里我们使用重新启动的方式
      this.play(process.filePath, process.currentTime).then((result) => {
        const newProcess = this.processes.get(result.processId);
        if (newProcess) {
          newProcess.isPaused = process.isPaused;
          newProcess.duration = process.duration;
        }
        this.processes.delete(processId);
      });
    }
  }

  /**
   * 获取播放状态
   */
  getStatus(processId: number): {
    currentTime: number;
    duration: number;
    isPaused: boolean;
    ended: boolean;
  } {
    const process = this.processes.get(processId);
    if (process) {
      return {
        currentTime: process.currentTime,
        duration: process.duration,
        isPaused: process.isPaused,
        ended: process.ended,
      };
    }
    return {
      currentTime: 0,
      duration: 0,
      isPaused: false,
      ended: true,
    };
  }

  /**
   * 清理所有进程
   */
  cleanup(): void {
    for (const [_processId, process] of this.processes) {
      try {
        process.process.kill();
      } catch {
        // ignore
      }
    }
    this.processes.clear();
  }
}

// 导出单例
export const ffplayAudioService = new FFplayAudioService();
