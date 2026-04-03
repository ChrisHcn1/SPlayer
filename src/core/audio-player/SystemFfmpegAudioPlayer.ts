import { toError } from "@/utils/error";
import { type GetDetail } from "@/utils/TypedEventTarget";
import { AudioErrorCode, BaseAudioPlayer, type AudioEventMap } from "./BaseAudioPlayer";
import { EngineCapabilities } from "./IPlaybackEngine";

/**
 * 基于系统 FFmpeg 的音频播放器实现
 *
 * 使用系统安装的 FFmpeg 进行音频解码，支持更多音频格式。
 * 解码后的 PCM 数据通过 AudioBufferSourceNode 播放。
 */
export class SystemFfmpegAudioPlayer extends BaseAudioPlayer {
  /** 当前播放器状态 */
  private playerState: "idle" | "loading" | "ready" | "playing" | "paused" | "error" = "idle";
  /** 音频元数据 */
  private metadata: {
    sampleRate: number;
    channels: number;
    duration: number;
  } | null = null;
  /** 下一个 AudioBufferSourceNode 的开始时间 */
  // private nextStartTime = 0;
  /** 当前正在播放的 AudioBufferSourceNode 实例 */
  private activeSources: AudioBufferSourceNode[] = [];
  /** 解码是否已完成 */
  private isDecodingFinished = false;
  /** 当前播放速率 */
  private currentTempo = 1.0;
  /** 锚点时刻的 AudioContext 时间 */
  private anchorWallTime = 0;
  /** 锚点时刻的 音频资源 时间（00:00） */
  private anchorSourceTime = 0;
  /** 时间更新定时器 ID */
  private timeUpdateIntervalId: ReturnType<typeof setInterval> | null = null;
  /** 当前加载的文件路径或 URL */
  private currentSrc: string | null = null;
  /** 解码后的音频数据 */
  private decodedAudioData: Float32Array | null = null;
  /** 是否正在播放 */
  private isPlaying = false;

  public readonly capabilities: EngineCapabilities = {
    supportsRate: true,
    supportsSinkId: true,
    supportsEqualizer: true,
    supportsSpectrum: true,
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
    if (!this.audioCtx) return 0;
    const wallDelta = this.audioCtx.currentTime - this.anchorWallTime;
    const currentPosition = this.anchorSourceTime + wallDelta * this.currentTempo;
    return Math.max(0, currentPosition);
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
    this.reset();
    this.dispatch("loadstart");

    try {
      let fileUrl: string;

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
        fileUrl = data.url;
        this.currentSrc = `local://${url.name}`;
      } else {
        // 处理 URL
        fileUrl = url;
        this.currentSrc = url;
      }

      // 获取音频元数据
      const metadataResponse = await fetch(
        `http://localhost:25884/api/ffmpeg/metadata?url=${encodeURIComponent(fileUrl)}`,
      );
      if (!metadataResponse.ok) {
        throw new Error(`Failed to get metadata: ${metadataResponse.statusText}`);
      }
      const metadataData = await metadataResponse.json();
      this.metadata = metadataData;

      // 解码音频为 PCM
      const decodeResponse = await fetch(
        `http://localhost:25884/api/ffmpeg/decode?url=${encodeURIComponent(fileUrl)}`,
      );
      if (!decodeResponse.ok) {
        throw new Error(`Failed to decode audio: ${decodeResponse.statusText}`);
      }
      const arrayBuffer = await decodeResponse.arrayBuffer();
      const pcmData = new Int16Array(arrayBuffer);

      // 转换为 Float32Array
      const float32Data = new Float32Array(pcmData.length);
      for (let i = 0; i < pcmData.length; i++) {
        float32Data[i] = pcmData[i] / 32768;
      }
      this.decodedAudioData = float32Data;

      this.playerState = "ready";
      this.dispatch("canplay");
    } catch (e) {
      const err = toError(e);
      console.error("[SystemFfmpegAudioPlayer] Load error:", err);
      this.playerState = "error";
      this.dispatch("error", {
        originalEvent: new Event("error"),
        errorCode: AudioErrorCode.DECODE,
      });
    }
  }

  protected async doPlay(): Promise<void> {
    if (!this.metadata || !this.decodedAudioData || !this.audioCtx) {
      throw new Error("Player not initialized");
    }

    this.dispatch("play");
    this.playerState = "playing";
    this.isPlaying = true;
    this.startTimeUpdate();

    try {
      // 创建 AudioBuffer
      const audioBuffer = this.audioCtx.createBuffer(
        this.metadata.channels,
        this.decodedAudioData.length / this.metadata.channels,
        this.metadata.sampleRate,
      );

      // 填充音频数据
      for (let channel = 0; channel < this.metadata.channels; channel++) {
        const channelData = audioBuffer.getChannelData(channel);
        for (let i = 0; i < channelData.length; i++) {
          channelData[i] = this.decodedAudioData[i * this.metadata.channels + channel];
        }
      }

      // 创建 AudioBufferSourceNode
      const source = this.audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.inputNode!);

      // 设置播放速率
      source.playbackRate.value = this.currentTempo;

      // 开始播放
      const now = this.audioCtx.currentTime;
      source.start(now);
      this.syncTimeAnchor(now, 0);

      // 保存活动源
      this.activeSources.push(source);

      // 监听结束事件
      source.onended = () => {
        const index = this.activeSources.indexOf(source);
        if (index !== -1) {
          this.activeSources.splice(index, 1);
        }

        if (this.activeSources.length === 0 && this.isPlaying) {
          this.isDecodingFinished = true;
          this.checkIfEnded();
        }
      };

      this.dispatch("playing");
    } catch (error) {
      console.error("[SystemFfmpegAudioPlayer] Play error:", error);
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
    this.isPlaying = false;
    this.stopTimeUpdate();

    // 停止所有活动的音频源
    this.activeSources.forEach((source) => {
      try {
        source.stop();
      } catch {
        // ignore
      }
    });
    this.activeSources = [];
  }

  protected async doSeek(time: number): Promise<void> {
    if (!this.metadata || !this.decodedAudioData || !this.audioCtx) {
      throw new Error("Player not initialized");
    }

    this.dispatch("seeking");

    // 停止所有活动的音频源
    this.activeSources.forEach((source) => {
      try {
        source.stop();
      } catch {
        // ignore
      }
    });
    this.activeSources = [];

    // 计算 seek 位置的样本索引
    const sampleIndex = Math.floor(time * this.metadata.sampleRate * this.metadata.channels);
    const seekedData = this.decodedAudioData.slice(sampleIndex);

    // 创建 AudioBuffer
    const audioBuffer = this.audioCtx.createBuffer(
      this.metadata.channels,
      seekedData.length / this.metadata.channels,
      this.metadata.sampleRate,
    );

    // 填充音频数据
    for (let channel = 0; channel < this.metadata.channels; channel++) {
      const channelData = audioBuffer.getChannelData(channel);
      for (let i = 0; i < channelData.length; i++) {
        channelData[i] = seekedData[i * this.metadata.channels + channel];
      }
    }

    // 创建 AudioBufferSourceNode
    const source = this.audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.inputNode!);

    // 设置播放速率
    source.playbackRate.value = this.currentTempo;

    // 开始播放
    const now = this.audioCtx.currentTime;
    source.start(now);
    this.syncTimeAnchor(now, time);

    // 保存活动源
    this.activeSources.push(source);

    // 监听结束事件
    source.onended = () => {
      const index = this.activeSources.indexOf(source);
      if (index !== -1) {
        this.activeSources.splice(index, 1);
      }

      if (this.activeSources.length === 0 && this.isPlaying) {
        this.isDecodingFinished = true;
        this.checkIfEnded();
      }
    };

    this.dispatch("seeked");
    this.dispatch("timeupdate");
  }

  public setRate(value: number): void {
    this.currentTempo = value;
    this.activeSources.forEach((source) => {
      source.playbackRate.value = value;
    });
  }

  public getRate(): number {
    return this.currentTempo;
  }

  protected async doSetSinkId(_deviceId: string): Promise<void> {
    return Promise.resolve();
  }

  protected onGraphInitialized(): void {
    // 系统 FFmpeg 播放器不需要额外的初始化操作
  }

  private syncTimeAnchor(wallTime: number, sourceTime: number) {
    this.anchorWallTime = wallTime;
    this.anchorSourceTime = sourceTime;
  }

  private checkIfEnded() {
    if (this.playerState !== "playing") return;
    if (this.activeSources.length > 0) return;
    if (!this.isDecodingFinished) return;

    this.playerState = "idle";
    this.dispatch("ended", undefined);
  }

  private startTimeUpdate() {
    this.stopTimeUpdate();
    this.timeUpdateIntervalId = setInterval(() => {
      if (this.playerState === "playing") {
        this.dispatch("timeupdate", undefined);
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

  private reset() {
    this.stopTimeUpdate();
    this.activeSources.forEach((source) => {
      try {
        source.stop();
      } catch {
        // ignore
      }
    });
    this.activeSources = [];

    this.metadata = null;
    this.decodedAudioData = null;
    this.isDecodingFinished = false;
    this.currentSrc = null;
    this.isPlaying = false;

    this.dispatch("emptied", undefined);
  }

  public destroy() {
    this.reset();
    super.destroy();
  }
}
