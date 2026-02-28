import { toError } from "@/utils/error";
import { type GetDetail } from "@/utils/TypedEventTarget";
import { AudioErrorCode, BaseAudioPlayer, type AudioEventMap } from "./BaseAudioPlayer";
import { EngineCapabilities } from "./IPlaybackEngine";

/**
 * 基于二进制 FFmpeg 的音频播放器实现
 * 
 * 使用 Electron 主进程的 FFmpeg 进行实时解码，支持更多音频格式（如 DTS、APE、DSD 等）
 * 解码后的 PCM 数据通过 AudioBufferSourceNode 播放
 */

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const HIGH_WATER_MARK = 30;
const LOW_WATER_MARK = 10;

interface FFmpegBinaryPlayerOptions {
  /** 音频文件路径 */
  filePath: string;
  /** 解码 ID */
  decodeId: string;
  /** 音频元数据 */
  metadata: {
    duration: number;
    sampleRate: number;
    channels: number;
    bitDepth: number;
  };
}

/**
 * 基于二进制 FFmpeg 的音频播放器
 */
export class FFmpegBinaryPlayer extends BaseAudioPlayer {
  /** 当前播放器状态 */
  private playerState: "idle" | "loading" | "playing" | "paused" | "ended" | "error" = "idle";
  
  /** 音频元数据 */
  private metadata: {
    duration: number;
    sampleRate: number;
    channels: number;
    bitDepth: number;
  } | null = null;

  /** 解码 ID */
  private decodeId: string | null = null;
  
  /** 文件路径 */
  private filePath: string | null = null;

  /** 下一个 AudioBufferSourceNode 的开始时间 */
  private nextStartTime = 0;
  
  /** 当前正在播放的 AudioBufferSourceNode 实例 */
  private activeSources: AudioBufferSourceNode[] = [];
  
  /** 当前播放速率 */
  private currentTempo = 1.0;

  /** 锚点时刻的 AudioContext 时间 */
  private anchorWallTime = 0;
  
  /** 锚点时刻的音频资源时间（00:00） */
  private anchorSourceTime = 0;

  /** 时间更新定时器 ID */
  private timeUpdateIntervalId: ReturnType<typeof setInterval> | null = null;

  /** 是否正在读取数据 */
  private isReading = false;

  /** PCM 数据缓冲区 */
  private pcmBuffer: Int16Array[] = [];
  
  /** 缓冲区总时长（秒） */
  private bufferedDuration = 0;

  /** 采样率 */
  private sampleRate = 48000;
  
  /** 声道数 */
  private channels = 2;

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
    return Math.max(0, Math.min(currentPosition, this.duration));
  }

  public get buffered() {
    return this.bufferedDuration;
  }

  /**
   * 加载音频文件
   */
  async load(url: string, autoPlay = false): Promise<void> {
    try {
      this.playerState = "loading";
      this.emit("loadstart", { url });

      // 检查是否需要 FFmpeg 解码
      const needsDecode = await window.electron.ipcRenderer.invoke("ffmpeg-decode:needs-decode", url);
      
      if (!needsDecode) {
        throw new Error("File format does not need FFmpeg decode");
      }

      // 获取元数据
      const metadataResult = await window.electron.ipcRenderer.invoke("ffmpeg-decode:get-metadata", url);
      if (!metadataResult.success) {
        throw new Error(metadataResult.error || "Failed to get metadata");
      }

      this.metadata = metadataResult.metadata;
      this.filePath = url;
      this.sampleRate = this.metadata.sampleRate;
      this.channels = this.metadata.channels;

      // 开始解码
      const decodeResult = await window.electron.ipcRenderer.invoke("ffmpeg-decode:start", url);
      if (!decodeResult.success) {
        throw new Error(decodeResult.error || "Failed to start decode");
      }

      this.decodeId = decodeResult.decodeId;

      // 初始化 AudioContext
      this.initAudioContext();

      // 预缓冲一些数据
      await this.preBuffer();

      this.playerState = "idle";
      this.emit("loadedmetadata", {
        duration: this.metadata.duration,
      });
      this.emit("canplay");

      if (autoPlay) {
        await this.play();
      }
    } catch (error) {
      this.playerState = "error";
      this.emit("error", {
        originalEvent: toError(error),
        errorCode: AudioErrorCode.DecodeError,
        message: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * 预缓冲数据
   */
  private async preBuffer(): Promise<void> {
    // 读取前 5 秒的数据
    const targetDuration = 5;
    const targetSamples = targetDuration * this.sampleRate * this.channels;
    const targetBytes = targetSamples * 2; // 16-bit = 2 bytes

    while (this.bufferedDuration < targetDuration && this.isReading) {
      const result = await window.electron.ipcRenderer.invoke(
        "ffmpeg-decode:read",
        this.decodeId,
        65536
      );

      if (!result.success) {
        break;
      }

      if (result.data) {
        const pcmData = new Int16Array(Buffer.from(result.data, "base64").buffer);
        this.pcmBuffer.push(pcmData);
        this.bufferedDuration += pcmData.length / (this.sampleRate * this.channels);
      }

      if (result.done) {
        break;
      }
    }
  }

  /**
   * 播放音频
   */
  async play(): Promise<void> {
    if (this.playerState === "playing") return;

    try {
      await this.resumeAudioContext();

      this.anchorWallTime = this.audioCtx!.currentTime;
      this.anchorSourceTime = this.currentTime;
      this.nextStartTime = this.audioCtx!.currentTime;

      this.playerState = "playing";
      this.isReading = true;

      // 开始播放缓冲的数据
      this.playBufferedData();

      // 开始读取更多数据
      this.startReading();

      // 启动时间更新定时器
      this.startTimeUpdate();

      this.emit("play");
    } catch (error) {
      this.emit("error", {
        originalEvent: toError(error),
        errorCode: AudioErrorCode.PlayError,
        message: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * 播放缓冲的 PCM 数据
   */
  private playBufferedData(): void {
    if (!this.audioCtx || this.pcmBuffer.length === 0) return;

    const audioBuffer = this.audioCtx.createBuffer(
      this.channels,
      this.pcmBuffer[0].length / this.channels,
      this.sampleRate
    );

    // 将 PCM 数据填充到 AudioBuffer
    for (let channel = 0; channel < this.channels; channel++) {
      const channelData = audioBuffer.getChannelData(channel);
      const pcmData = this.pcmBuffer[0];
      
      for (let i = 0; i < channelData.length; i++) {
        // 将 16-bit PCM 转换为 Float32 (-1.0 to 1.0)
        channelData[i] = pcmData[i * this.channels + channel] / 32768;
      }
    }

    // 创建 AudioBufferSourceNode
    const source = this.audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.playbackRate.value = this.currentTempo;
    
    // 连接音频图
    source.connect(this.getOutputNode());

    // 播放
    source.start(this.nextStartTime);
    this.activeSources.push(source);

    // 更新下一个开始时间
    this.nextStartTime += audioBuffer.duration / this.currentTempo;

    // 移除已播放的缓冲区
    this.pcmBuffer.shift();
    this.bufferedDuration -= audioBuffer.duration;

    // 监听播放结束
    source.onended = () => {
      const index = this.activeSources.indexOf(source);
      if (index > -1) {
        this.activeSources.splice(index, 1);
      }

      // 如果所有数据都播放完了
      if (this.activeSources.length === 0 && this.pcmBuffer.length === 0 && !this.isReading) {
        this.playerState = "ended";
        this.emit("ended");
      }
    };
  }

  /**
   * 开始读取 PCM 数据
   */
  private async startReading(): Promise<void> {
    if (!this.isReading || !this.decodeId) return;

    try {
      while (this.isReading && this.bufferedDuration < HIGH_WATER_MARK) {
        const result = await window.electron.ipcRenderer.invoke(
          "ffmpeg-decode:read",
          this.decodeId,
          65536
        );

        if (!result.success) {
          this.isReading = false;
          break;
        }

        if (result.data) {
          const pcmData = new Int16Array(Buffer.from(result.data, "base64").buffer);
          this.pcmBuffer.push(pcmData);
          this.bufferedDuration += pcmData.length / (this.sampleRate * this.channels);
        }

        if (result.done) {
          this.isReading = false;
          break;
        }
      }

      // 如果缓冲区低于低水位，继续读取
      if (this.isReading && this.bufferedDuration < LOW_WATER_MARK) {
        setTimeout(() => this.startReading(), 0);
      }
    } catch (error) {
      this.isReading = false;
      console.error("[FFmpegBinaryPlayer] Error reading PCM data:", error);
    }
  }

  /**
   * 暂停播放
   */
  async pause(): Promise<void> {
    if (this.playerState !== "playing") return;

    this.playerState = "paused";
    this.isReading = false;

    // 停止所有正在播放的源
    this.activeSources.forEach((source) => {
      try {
        source.stop();
      } catch {
        // 忽略已经停止的源的错误
      }
    });
    this.activeSources = [];

    this.stopTimeUpdate();
    this.emit("pause");
  }

  /**
   * 跳转到指定时间
   */
  async seek(time: number): Promise<void> {
    const wasPlaying = this.playerState === "playing";

    // 停止当前播放
    this.activeSources.forEach((source) => {
      try {
        source.stop();
      } catch {
        // 忽略已经停止的源的错误
      }
    });
    this.activeSources = [];

    // 清空缓冲区
    this.pcmBuffer = [];
    this.bufferedDuration = 0;

    // 更新锚点
    this.anchorSourceTime = time;
    this.anchorWallTime = this.audioCtx?.currentTime || 0;
    this.nextStartTime = this.audioCtx?.currentTime || 0;

    // 重新加载并解码
    if (this.decodeId) {
      await window.electron.ipcRenderer.invoke("ffmpeg-decode:stop", this.decodeId);
    }

    if (this.filePath) {
      const decodeResult = await window.electron.ipcRenderer.invoke(
        "ffmpeg-decode:start",
        this.filePath
      );
      if (decodeResult.success) {
        this.decodeId = decodeResult.decodeId;
        
        // 预缓冲
        this.isReading = true;
        await this.preBuffer();

        if (wasPlaying) {
          await this.play();
        }
      }
    }

    this.emit("seeked");
  }

  /**
   * 设置播放速率
   */
  setRate(rate: number): void {
    this.currentTempo = rate;
    this.activeSources.forEach((source) => {
      source.playbackRate.value = rate;
    });
  }

  /**
   * 停止播放
   */
  stop(): void {
    this.playerState = "idle";
    this.isReading = false;

    // 停止所有正在播放的源
    this.activeSources.forEach((source) => {
      try {
        source.stop();
      } catch {
        // 忽略已经停止的源的错误
      }
    });
    this.activeSources = [];

    // 停止解码
    if (this.decodeId) {
      window.electron.ipcRenderer.invoke("ffmpeg-decode:stop", this.decodeId);
      this.decodeId = null;
    }

    // 清空缓冲区
    this.pcmBuffer = [];
    this.bufferedDuration = 0;

    this.stopTimeUpdate();
    this.emit("stop");
  }

  /**
   * 销毁播放器
   */
  destroy(): void {
    this.stop();
    this.destroyAudioContext();
  }

  /**
   * 启动时间更新定时器
   */
  private startTimeUpdate(): void {
    this.stopTimeUpdate();
    this.timeUpdateIntervalId = setInterval(() => {
      this.emit("timeupdate", { currentTime: this.currentTime });
    }, 250);
  }

  /**
   * 停止时间更新定时器
   */
  private stopTimeUpdate(): void {
    if (this.timeUpdateIntervalId) {
      clearInterval(this.timeUpdateIntervalId);
      this.timeUpdateIntervalId = null;
    }
  }
}
