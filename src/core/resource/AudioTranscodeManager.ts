import { isElectron } from "@/utils/env";
import type { SongType } from "@/types/main";

type TranscodeStatus = "idle" | "transcoding" | "completed" | "failed";

interface TranscodeJob {
  songId: number | string;
  sourcePath: string;
  targetPath: string;
  status: TranscodeStatus;
  progress: number;
  error?: string;
}

class AudioTranscodeManager {
  private jobs: Map<string, TranscodeJob> = new Map();
  private ffmpegAvailable: boolean = false;
  private ffmpegChecked: boolean = false;
  private prefetchEnabled: boolean = true;
  private prefetchTimeMs: number = 10000;

  constructor() {
    this.setupProgressListener();
  }

  private needsTranscode(filePath: string): boolean {
    const ext = filePath.split(".").pop()?.toLowerCase() || "";
    const unsupportedFormats = ["ape", "dts", "dsd", "dsf", "dff", "wv", "tak", "tta", "mpc"];
    return unsupportedFormats.includes(ext);
  }

  private getJobKey(songId: number | string): string {
    return `transcode:${songId}`;
  }

  public async checkFFmpegAvailable(): Promise<boolean> {
    if (!isElectron) return false;

    if (this.ffmpegChecked) {
      return this.ffmpegAvailable;
    }

    this.ffmpegChecked = true;

    try {
      const result = await window.electron.ipcRenderer.invoke(
        "audio-transcode-check-ffmpeg",
      );
      this.ffmpegAvailable = result.available || false;
      console.log(
        `[AudioTranscode] FFmpeg available: ${this.ffmpegAvailable}`,
      );
      return this.ffmpegAvailable;
    } catch (error) {
      console.error("[AudioTranscode] FFmpeg check failed:", error);
      return false;
    }
  }

  private setupProgressListener(): void {
    if (!isElectron) return;

    window.electron.ipcRenderer.on(
      "audio-transcode-progress",
      (...args: unknown[]) => {
        const data = args[1] as { sourcePath: string; targetFormat: string; progress: number };
        for (const [key, job] of this.jobs) {
          if (job.sourcePath === data.sourcePath && job.status === "transcoding") {
            job.progress = data.progress;
            console.log(`[AudioTranscode] Progress for ${key}: ${data.progress}%`);
          }
        }
      },
    );
  }

  public async prefetchNextSong(
    song: SongType,
    playDurationMs: number,
  ): Promise<void> {
    if (!isElectron || !this.prefetchEnabled) return;
    if (!song.path || !this.needsTranscode(song.path)) return;

    const available = await this.checkFFmpegAvailable();
    if (!available) return;

    // FFmpeg 可用时，使用 FFmpeg 实时解码，不需要预转码
    console.log(`[AudioTranscode] FFmpeg 可用，使用实时解码，跳过预转码: ${song.id}`);
    return;

    // 以下预转码逻辑已禁用
    /*
    const jobKey = this.getJobKey(song.id);
    const existingJob = this.jobs.get(jobKey);

    if (existingJob && existingJob.status === "transcoding") {
      console.log(`[AudioTranscode] Transcoding already in progress for song ${song.id}`);
      return;
    }

    if (existingJob && existingJob.status === "completed") {
      console.log(`[AudioTranscode] Song ${song.id} already transcoded`);
      return;
    }

    const prefetchDelay = Math.max(0, playDurationMs - this.prefetchTimeMs);
    console.log(
      `[AudioTranscode] Scheduling transcode for song ${song.id} in ${prefetchDelay}ms`,
    );

    setTimeout(async () => {
      await this.transcodeSong(song);
    }, prefetchDelay);
    */
  }

  public async transcodeSong(song: SongType): Promise<string | null> {
    if (!isElectron || !song.path) return null;

    console.log(`[AudioTranscode] 处理歌曲: ${song.id}, 路径: ${song.path}`);

    const available = await this.checkFFmpegAvailable();
    if (!available) {
      console.warn("[AudioTranscode] FFmpeg not available");
      return null;
    }

    // 如果 FFmpeg 可用，直接使用 FFmpeg 解码播放，不需要转码
    // 返回原文件路径，让 FFmpegBinaryPlayer 处理解码
    console.log(`[AudioTranscode] FFmpeg 可用，使用 FFmpeg 解码播放，跳过转码: ${song.path}`);
    return song.path;

    // 以下转码逻辑已禁用，使用 FFmpeg 实时解码替代
    /*
    const jobKey = this.getJobKey(song.id);
    const existingJob = this.jobs.get(jobKey);

    if (existingJob && existingJob.status === "transcoding") {
      console.log(`[AudioTranscode] Transcoding already in progress for song ${song.id}`);
      return existingJob.targetPath;
    }

    if (existingJob && existingJob.status === "completed") {
      console.log(`[AudioTranscode] Song ${song.id} already transcoded`);
      return existingJob.targetPath;
    }

    const job: TranscodeJob = {
      songId: song.id,
      sourcePath: song.path,
      targetPath: "",
      status: "transcoding",
      progress: 0,
    };

    this.jobs.set(jobKey, job);

    try {
      console.log(`[AudioTranscode] Starting transcode for song ${song.id}: ${song.path}`);

      const result = await window.electron.ipcRenderer.invoke(
        "audio-transcode",
        song.path,
        "flac",
      );

      console.log(`[AudioTranscode] Transcode result:`, result);

      if (result.success && result.targetPath) {
        job.targetPath = result.targetPath;
        job.status = "completed";
        job.progress = 100;
        console.log(`[AudioTranscode] Transcoding completed for song ${song.id}: ${result.targetPath}`);
        return result.targetPath;
      } else {
        job.status = "failed";
        job.error = result.error || "Unknown error";
        console.error(`[AudioTranscode] Transcoding failed for song ${song.id}: ${job.error}`);
        return null;
      }
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      console.error(`[AudioTranscode] Transcoding error for song ${song.id}:`, error);
      return null;
    }
  }

  public getTranscodedPath(songId: number | string): string | null {
    const jobKey = this.getJobKey(songId);
    const job = this.jobs.get(jobKey);

    if (job && job.status === "completed") {
      return job.targetPath;
    }

    return null;
  }

  public getJobStatus(songId: number | string): TranscodeJob | undefined {
    const jobKey = this.getJobKey(songId);
    return this.jobs.get(jobKey);
  }

  public cancelTranscode(songId: number | string): boolean {
    const jobKey = this.getJobKey(songId);
    const job = this.jobs.get(jobKey);

    if (job && job.status === "transcoding") {
      window.electron.ipcRenderer
        .invoke("audio-transcode-cancel", job.sourcePath, "flac")
        .catch(console.error);
      job.status = "failed";
      job.error = "Cancelled";
      return true;
    }

    return false;
  }

  public clearJobs(): void {
    this.jobs.clear();
  }

  public setPrefetchEnabled(enabled: boolean): void {
    this.prefetchEnabled = enabled;
  }

  public setPrefetchTimeMs(timeMs: number): void {
    this.prefetchTimeMs = Math.max(1000, timeMs);
  }

  public isFFmpegAvailable(): boolean {
    return this.ffmpegAvailable;
  }

  public resetFFmpegCache(): void {
    this.ffmpegChecked = false;
    this.ffmpegAvailable = false;
    console.log("[AudioTranscode] FFmpeg cache reset");
  }
}

const audioTranscodeManager = new AudioTranscodeManager();

export default audioTranscodeManager;