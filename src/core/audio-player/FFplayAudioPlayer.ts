import { toError } from "@/utils/error";
import { type GetDetail } from "@/utils/TypedEventTarget";
import { AudioErrorCode, BaseAudioPlayer, type AudioEventMap } from "./BaseAudioPlayer";
import { EngineCapabilities } from "./IPlaybackEngine";

/**
 * 基于 FFplay 的音频播放器实现
 *
 * 使用项目目录下的 ffplay.exe 进行音频播放，支持更多音频格式。
 * 提供完整的播放控制和进度管理。
 */
export class FFplayAudioPlayer extends BaseAudioPlayer {
  /** 当前播放器状态 */
  private playerState: "idle" | "loading" | "ready" | "playing" | "paused" | "error" = "idle";
  /** 音频元数据 */
  private metadata: {
    sampleRate: number;
    channels: number;
    duration: number;
    title?: string;
    artist?: string;
    album?: string;
  } | null = null;
  /** 时间更新定时器 ID */
  private timeUpdateIntervalId: ReturnType<typeof setInterval> | null = null;
  /** 当前加载的文件路径或 URL */
  private currentSrc: string | null = null;

  /** 当前播放时间 */
  private currentTimeValue = 0;
  /** 播放速率 */
  private currentTempo = 1.0;
  /** FFplay 进程 ID */
  private ffplayProcessId: number | null = null;

  public readonly capabilities: EngineCapabilities = {
    supportsRate: true,
    supportsSinkId: false,
    supportsEqualizer: false,
    supportsSpectrum: false,
  };

  constructor() {
    super();
  }

  public get state() {
    return this.playerState;
  }

  public get duration() {
    return this.metadata?.duration || 0;
  }

  public get currentTime() {
    return this.currentTimeValue;
  }

  public get audioInfo() {
    return this.metadata;
  }

  public get src(): string {
    return this.currentSrc || "";
  }

  public get paused(): boolean {
    return (
      this.playerState === "paused" ||
      this.playerState === "idle" ||
      this.playerState === "error" ||
      this.playerState === "ready"
    );
  }

  public getErrorCode(): number {
    return 0;
  }

  public async load(url: string | File) {
    await this.reset();
    this.dispatch("loadstart");

    try {
      let filePath: string;

      if (url instanceof File) {
        // 处理本地文件
        const formData = new FormData();
        formData.append("file", url);
        const response = await fetch("http://localhost:25884/api/upload", {
          method: "POST",
          body: formData,
        });
        if (!response.ok) {
          throw new Error(`Failed to upload file: ${response.statusText}`);
        }
        const data = await response.json();
        filePath = data.path;
        this.currentSrc = `local://${url.name}`;
      } else {
        // 处理 URL
        filePath = url;
        this.currentSrc = url;
      }

      // 确保路径格式正确，移除file://前缀
      let metadataPath = filePath;
      if (metadataPath.startsWith("file://")) {
        metadataPath = metadataPath.substring(7);
      }

      // 获取音频元数据
      const metadataResponse = await fetch(
        `http://localhost:25884/api/ffplay/metadata?path=${encodeURIComponent(metadataPath)}`,
      );
      if (!metadataResponse.ok) {
        throw new Error(`Failed to get metadata: ${metadataResponse.statusText}`);
      }
      const metadataData = await metadataResponse.json();
      this.metadata = metadataData;

      this.playerState = "ready";
      this.dispatch("canplay");
    } catch (e) {
      const err = toError(e);
      console.error("[FFplayAudioPlayer] Load error:", err);
      this.playerState = "error";
      this.dispatch("error", {
        originalEvent: new Event("error"),
        errorCode: AudioErrorCode.DECODE,
      });
    }
  }

  protected async doPlay(): Promise<void> {
    if (!this.metadata || !this.currentSrc) {
      throw new Error("Player not initialized");
    }

    this.dispatch("play");
    this.playerState = "playing";
    this.startTimeUpdate();

    try {
      // 确保路径格式正确，移除file://前缀
      let playPath = this.currentSrc;
      if (playPath.startsWith("file://")) {
        playPath = playPath.substring(7);
      }

      // 启动 ffplay 播放
      const response = await fetch(
        `http://localhost:25884/api/ffplay/play?path=${encodeURIComponent(playPath)}&startTime=${this.currentTimeValue}`,
      );
      if (!response.ok) {
        throw new Error(`Failed to start ffplay: ${response.statusText}`);
      }
      const result = await response.json();
      this.ffplayProcessId = result.processId;

      this.dispatch("playing");
    } catch (error) {
      console.error("[FFplayAudioPlayer] Play error:", error);
      this.playerState = "error";
      this.dispatch("error", {
        originalEvent: new Event("error"),
        errorCode: AudioErrorCode.DECODE,
      });
    }
  }

  protected async doPause(): Promise<void> {
    this.dispatch("pause");
    this.playerState = "paused";
    this.stopTimeUpdate();

    try {
      if (this.ffplayProcessId) {
        await fetch(`http://localhost:25884/api/ffplay/pause?processId=${this.ffplayProcessId}`);
      }
    } catch {
      // ignore
    }
  }

  protected async doSeek(time: number): Promise<void> {
    if (!this.metadata || !this.currentSrc) {
      throw new Error("Player not initialized");
    }

    this.dispatch("seeking");

    try {
      if (this.ffplayProcessId) {
        const response = await fetch(
          `http://localhost:25884/api/ffplay/seek?processId=${this.ffplayProcessId}&time=${time}`,
        );
        if (response.ok) {
          const result = await response.json();
          if (result.processId) {
            this.ffplayProcessId = result.processId;
          }
        }
      }
      this.currentTimeValue = time;

      this.dispatch("seeked");
      this.dispatch("timeupdate");
    } catch (error) {
      console.error("[FFplayAudioPlayer] Seek error:", error);
    }
  }

  public setRate(value: number): void {
    this.currentTempo = value;
    if (this.ffplayProcessId) {
      fetch(
        `http://localhost:25884/api/ffplay/rate?processId=${this.ffplayProcessId}&rate=${value}`,
      ).catch(() => {
        // ignore
      });
    }
  }

  public getRate(): number {
    return this.currentTempo;
  }

  protected async doSetSinkId(_deviceId: string): Promise<void> {
    return Promise.resolve();
  }

  protected onGraphInitialized(): void {
    // FFplay 播放器不需要额外的初始化操作
  }

  private startTimeUpdate() {
    this.stopTimeUpdate();
    this.timeUpdateIntervalId = setInterval(async () => {
      if (this.playerState === "playing" && this.ffplayProcessId) {
        try {
          const response = await fetch(
            `http://localhost:25884/api/ffplay/status?processId=${this.ffplayProcessId}`,
          );
          if (response.ok) {
            const status = await response.json();
            this.currentTimeValue = status.currentTime;
            this.dispatch("timeupdate", undefined);

            // 检查是否播放结束
            if (status.ended) {
              this.playerState = "idle";
              this.stopTimeUpdate();
              this.dispatch("ended", undefined);
            }
          }
        } catch {
          // ignore
        }
      }
    }, 250);
  }

  private stopTimeUpdate() {
    if (this.timeUpdateIntervalId !== null) {
      clearInterval(this.timeUpdateIntervalId);
      this.timeUpdateIntervalId = null;
    }
  }

  public dispatch<K extends keyof AudioEventMap>(
    type: K,
    ...args: GetDetail<AudioEventMap[K]> extends undefined
      ? [detail?: GetDetail<AudioEventMap[K]>]
      : [detail: GetDetail<AudioEventMap[K]>]
  ): boolean {
    switch (type) {
      case "loadstart":
        this.playerState = "loading";
        break;
      case "canplay":
        if (this.playerState !== "playing" && this.playerState !== "error") {
          this.playerState = "ready";
        }
        break;
      case "playing":
        this.playerState = "playing";
        break;
      case "pause":
        this.playerState = "paused";
        break;
      case "ended":
        this.playerState = "idle";
        break;
      case "error":
        this.playerState = "error";
        break;
      case "emptied":
        this.playerState = "idle";
        break;
    }
    return super.dispatch(type, ...args);
  }

  private async reset(): Promise<void> {
    this.stopTimeUpdate();

    // 停止 ffplay 进程
    if (this.ffplayProcessId) {
      try {
        await fetch(`http://localhost:25884/api/ffplay/stop?processId=${this.ffplayProcessId}`);
      } catch {
        // ignore
      }
      this.ffplayProcessId = null;
    }

    this.metadata = null;
    this.currentSrc = null;
    this.currentTimeValue = 0;

    this.dispatch("emptied", undefined);
  }

  public destroy() {
    this.reset();
    super.destroy();
  }
}
