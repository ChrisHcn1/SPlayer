import { toError } from "@/utils/error";
import { AudioErrorCode, BaseAudioPlayer } from "./BaseAudioPlayer";
import { EngineCapabilities } from "./IPlaybackEngine";

const HIGH_WATER_MARK = 30;
const LOW_WATER_MARK = 10;

export class FFmpegBinaryPlayer extends BaseAudioPlayer {
  private playerState: "idle" | "loading" | "playing" | "paused" | "ended" | "error" = "idle";
  
  private metadata: {
    duration: number;
    sampleRate: number;
    channels: number;
    bitDepth: number;
  } | null = null;

  private decodeId: string | null = null;
  private filePath: string | null = null;
  private nextStartTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  private currentTempo = 1.0;
  private anchorWallTime = 0;
  private anchorSourceTime = 0;
  private timeUpdateIntervalId: ReturnType<typeof setInterval> | null = null;
  private isReading = false;
  private pcmBuffer: Int16Array[] = [];
  private bufferedDuration = 0;
  private sampleRate = 48000;
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

  public get paused() {
    return this.playerState === "paused" || this.playerState === "idle";
  }

  protected onGraphInitialized(): void {
    // FFmpeg 解码器不需要特殊的音频图初始化
  }

  async load(url: string, autoPlay = false): Promise<void> {
    try {
      this.playerState = "loading";
      this.dispatch("loadstart");

      const needsDecode = await window.electron.ipcRenderer.invoke("ffmpeg-decode:needs-decode", url);
      
      if (!needsDecode) {
        throw new Error("File format does not need FFmpeg decode");
      }

      const metadataResult = await window.electron.ipcRenderer.invoke("ffmpeg-decode:get-metadata", url);
      if (!metadataResult.success) {
        throw new Error(metadataResult.error || "Failed to get metadata");
      }

      this.metadata = metadataResult.metadata;
      this.filePath = url;
      this.sampleRate = this.metadata.sampleRate;
      this.channels = this.metadata.channels;

      const decodeResult = await window.electron.ipcRenderer.invoke("ffmpeg-decode:start", url);
      if (!decodeResult.success) {
        throw new Error(decodeResult.error || "Failed to start decode");
      }

      this.decodeId = decodeResult.decodeId;

      this.init();

      await this.preBuffer();

      this.playerState = "idle";
      this.dispatch("canplay");

      if (autoPlay) {
        await this.play();
      }
    } catch (error) {
      this.playerState = "error";
      this.dispatch("error", {
        originalEvent: toError(error),
        errorCode: AudioErrorCode.DECODE,
      });
      throw error;
    }
  }

  private async preBuffer(): Promise<void> {
    const targetDuration = 5;
    const targetSamples = targetDuration * this.sampleRate * this.channels;
    const targetBytes = targetSamples * 2;

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

  async play(url?: string, options?: { fadeIn?: boolean; fadeDuration?: number; autoPlay?: boolean; seek?: number }): Promise<void> {
    if (url) {
      await this.load(url, options?.autoPlay ?? true);
      return;
    }

    if (this.playerState === "playing") return;

    try {
      if (this.audioCtx?.state === "suspended") {
        await this.audioCtx.resume();
      }

      this.anchorWallTime = this.audioCtx!.currentTime;
      this.anchorSourceTime = this.currentTime;
      this.nextStartTime = this.audioCtx!.currentTime;

      this.playerState = "playing";
      this.isReading = true;

      this.playBufferedData();
      this.startReading();
      this.startTimeUpdate();

      this.dispatch("play");
    } catch (error) {
      this.dispatch("error", {
        originalEvent: toError(error),
        errorCode: AudioErrorCode.DECODE,
      });
      throw error;
    }
  }

  private playBufferedData(): void {
    if (!this.audioCtx || this.pcmBuffer.length === 0) return;

    const audioBuffer = this.audioCtx.createBuffer(
      this.channels,
      this.pcmBuffer[0].length / this.channels,
      this.sampleRate
    );

    for (let channel = 0; channel < this.channels; channel++) {
      const channelData = audioBuffer.getChannelData(channel);
      const pcmData = this.pcmBuffer[0];
      
      for (let i = 0; i < channelData.length; i++) {
        channelData[i] = pcmData[i * this.channels + channel] / 32768;
      }
    }

    const source = this.audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.playbackRate.value = this.currentTempo;
    
    source.connect(this.inputNode!);

    source.start(this.nextStartTime);
    this.activeSources.push(source);

    this.nextStartTime += audioBuffer.duration / this.currentTempo;

    this.pcmBuffer.shift();
    this.bufferedDuration -= audioBuffer.duration;

    source.onended = () => {
      const index = this.activeSources.indexOf(source);
      if (index > -1) {
        this.activeSources.splice(index, 1);
      }

      if (this.activeSources.length === 0 && this.pcmBuffer.length === 0 && !this.isReading) {
        this.playerState = "ended";
        this.dispatch("ended");
      }
    };
  }

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

      if (this.isReading && this.bufferedDuration < LOW_WATER_MARK) {
        setTimeout(() => this.startReading(), 0);
      }
    } catch (error) {
      this.isReading = false;
      console.error("[FFmpegBinaryPlayer] Error reading PCM data:", error);
    }
  }

  async pause(options?: { fadeOut?: boolean; fadeDuration?: number }): Promise<void> {
    if (this.playerState !== "playing") return;

    this.playerState = "paused";
    this.isReading = false;

    this.activeSources.forEach((source) => {
      try {
        source.stop();
      } catch {
        // 忽略已经停止的源的错误
      }
    });
    this.activeSources = [];

    this.stopTimeUpdate();
    this.dispatch("pause");
  }

  async seek(time: number): Promise<void> {
    const wasPlaying = this.playerState === "playing";

    this.activeSources.forEach((source) => {
      try {
        source.stop();
      } catch {
        // 忽略已经停止的源的错误
      }
    });
    this.activeSources = [];

    this.pcmBuffer = [];
    this.bufferedDuration = 0;

    this.anchorSourceTime = time;
    this.anchorWallTime = this.audioCtx?.currentTime || 0;
    this.nextStartTime = this.audioCtx?.currentTime || 0;

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
        
        this.isReading = true;
        await this.preBuffer();

        if (wasPlaying) {
          await this.play();
        }
      }
    }

    this.dispatch("seeked");
  }

  setRate(rate: number): void {
    this.currentTempo = rate;
    this.activeSources.forEach((source) => {
      source.playbackRate.value = rate;
    });
  }

  stop(): void {
    this.playerState = "idle";
    this.isReading = false;

    this.activeSources.forEach((source) => {
      try {
        source.stop();
      } catch {
        // 忽略已经停止的源的错误
      }
    });
    this.activeSources = [];

    if (this.decodeId) {
      window.electron.ipcRenderer.invoke("ffmpeg-decode:stop", this.decodeId);
      this.decodeId = null;
    }

    this.pcmBuffer = [];
    this.bufferedDuration = 0;

    this.stopTimeUpdate();
  }

  destroy(): void {
    this.stop();
    super.destroy();
  }

  private startTimeUpdate(): void {
    this.stopTimeUpdate();
    this.timeUpdateIntervalId = setInterval(() => {
      this.dispatch("timeupdate");
    }, 250);
  }

  private stopTimeUpdate(): void {
    if (this.timeUpdateIntervalId) {
      clearInterval(this.timeUpdateIntervalId);
      this.timeUpdateIntervalId = null;
    }
  }
}
