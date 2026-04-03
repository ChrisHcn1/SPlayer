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
    format: string;
    bitrate: number;
    codec: string;
    sampleFormat: string;
    averageBitrate: number;
    dsdOriginalSampleRate: number;
    dsdType: string;
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

  protected async doPlay(): Promise<void> {
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
        originalEvent: new Event("error"),
        errorCode: AudioErrorCode.DECODE,
      });
      throw error;
    }
  }

  protected async doPause(): Promise<void> {
    if (this.playerState !== "playing") return;

    this.playerState = "paused";
    this.isReading = false;

    this.stopTimeUpdate();

    this.activeSources.forEach((source) => {
      try {
        source.stop();
      } catch {
        // ignore
      }
    });
    this.activeSources = [];

    this.dispatch("pause");
  }

  protected async doSeek(time: number): Promise<void> {
    if (!this.filePath) return;

    this.isReading = false;

    this.activeSources.forEach((source) => {
      try {
        source.stop();
      } catch {
        // ignore
      }
    });
    this.activeSources = [];

    this.pcmBuffer = [];
    this.bufferedDuration = 0;

    if (this.decodeId) {
      await window.electron.ipcRenderer.invoke("ffmpeg-decode:stop", this.decodeId);
      this.decodeId = null;
    }

    const decodeResult = await window.electron.ipcRenderer.invoke(
      "ffmpeg-decode:start",
      this.filePath,
    );

    if (decodeResult.success) {
      this.decodeId = decodeResult.decodeId;

      this.isReading = true;
      await this.preBuffer();
      this.isReading = false;

      if (this.playerState === "playing") {
        this.anchorWallTime = this.audioCtx!.currentTime;
        this.anchorSourceTime = time;
        this.nextStartTime = this.audioCtx!.currentTime;
        this.playBufferedData();
        this.startReading();
      }
    }

    this.dispatch("seeked");
  }

  protected async doSetSinkId(_deviceId: string): Promise<void> {
    return Promise.resolve();
  }

  public getErrorCode(): number {
    return 0;
  }

  public getRate(): number {
    return this.currentTempo;
  }

  public get src(): string {
    return this.filePath || "";
  }

  public async load(url: string, autoPlay = false): Promise<void> {
    try {
      this.playerState = "loading";
      this.dispatch("loadstart");

      const filePath = url.startsWith("file://")
        ? decodeURIComponent(url.slice(7).replace(/\\/g, "/"))
        : url;

      const needsDecode = await window.electron.ipcRenderer.invoke(
        "ffmpeg-decode:needs-decode",
        filePath,
      );

      if (!needsDecode) {
        throw new Error("File format does not need FFmpeg decode");
      }

      const metadataResult = await window.electron.ipcRenderer.invoke(
        "ffmpeg-decode:get-metadata",
        filePath,
      );
      if (!metadataResult.success || !metadataResult.metadata) {
        throw new Error(metadataResult.error || "Failed to get metadata");
      }

      this.metadata = metadataResult.metadata;
      this.filePath = filePath;
      // 直接使用元数据中的采样率
      // 对于DSD音频，Rust代码已经计算了合适的PCM采样率
      this.sampleRate = this.metadata?.sampleRate || 44100;

      // 输出DSD相关信息
      if (this.metadata?.dsdType) {
        console.log(
          `[FFmpegBinaryPlayer] DSD音频信息: type=${this.metadata.dsdType}, originalSampleRate=${this.metadata.dsdOriginalSampleRate}Hz, outputSampleRate=${this.sampleRate}Hz`,
        );
      }
      this.channels = this.metadata?.channels || 2;

      const bitrate = this.metadata?.bitrate ? this.metadata.bitrate.toFixed(2) : "N/A";
      const codec = this.metadata?.codec || "N/A";
      const sampleFormat = this.metadata?.sampleFormat || "s16";
      const averageBitrate = this.metadata?.averageBitrate
        ? this.metadata.averageBitrate.toFixed(2)
        : "N/A";
      console.log(
        `[FFmpegBinaryPlayer] Metadata: sampleRate=${this.sampleRate}, channels=${this.channels}, bitDepth=${this.metadata?.bitDepth}, format=${this.metadata?.format}, bitrate=${bitrate}kbps, codec=${codec}, sampleFormat=${sampleFormat}, averageBitrate=${averageBitrate}kbps`,
      );

      if (this.metadata?.dsdType) {
        console.log(
          `[FFmpegBinaryPlayer] DSD Info: type=${this.metadata.dsdType}, originalSampleRate=${this.metadata.dsdOriginalSampleRate}`,
        );
      }

      // 根据比特率调整缓冲区大小，提高播放质量
      if (this.metadata?.bitrate) {
        console.log(`[FFmpegBinaryPlayer] Adjusting buffer size based on bitrate: ${bitrate}kbps`);
        // 可以根据比特率动态调整缓冲区大小
        // 高比特率文件可能需要更大的缓冲区
      }

      const decodeResult = await window.electron.ipcRenderer.invoke(
        "ffmpeg-decode:start",
        filePath,
      );
      if (!decodeResult.success) {
        throw new Error(decodeResult.error || "Failed to start decode");
      }

      this.decodeId = decodeResult.decodeId;

      this.init();
      console.log(
        `[FFmpegBinaryPlayer] Initialized with sample rate: ${this.sampleRate}, channels: ${this.channels}`,
      );
      console.log(`[FFmpegBinaryPlayer] AudioContext sample rate: ${this.audioCtx?.sampleRate}`);

      this.isReading = true;
      await this.preBuffer();
      this.isReading = false;

      // 检查缓冲数据
      console.log(
        `[FFmpegBinaryPlayer] Pre-buffer completed, buffered: ${this.pcmBuffer.length} chunks, duration: ${this.bufferedDuration.toFixed(2)}s`,
      );
      if (this.pcmBuffer.length > 0) {
        console.log(`[FFmpegBinaryPlayer] First chunk size: ${this.pcmBuffer[0].length} samples`);
      }

      this.playerState = "idle";
      this.dispatch("canplay");

      if (autoPlay) {
        await this.play();
      }
    } catch (error) {
      this.playerState = "error";
      this.dispatch("error", {
        originalEvent: new Event("error"),
        errorCode: AudioErrorCode.DECODE,
      });
      throw error;
    }
  }

  private async preBuffer(): Promise<void> {
    const targetDuration = 5;

    try {
      while (this.bufferedDuration < targetDuration) {
        const result = await window.electron.ipcRenderer.invoke(
          "ffmpeg-decode:read",
          this.decodeId,
          65536,
        );

        if (!result.success) {
          break;
        }

        if (result.data) {
          const binaryString = atob(result.data);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          const pcmData = new Int16Array(bytes.buffer);
          this.pcmBuffer.push(pcmData);
          // pcmData.length 是总采样数（包括所有声道）
          // 缓冲时长 = 总采样数 / 声道数 / 采样率
          // 使用实际的音频数据采样率来计算缓冲时长
          // 使用原始音频的采样率计算缓冲时长，确保播放速度正确
          this.bufferedDuration += pcmData.length / this.channels / this.sampleRate;
        }

        if (result.done) {
          break;
        }
      }
    } catch {
      // 忽略错误，保持播放状态
    }
  }

  private playBufferedData(): void {
    if (!this.audioCtx || this.pcmBuffer.length === 0) return;

    // 播放所有缓冲的数据
    while (this.pcmBuffer.length > 0) {
      const pcmData = this.pcmBuffer[0];
      const sourceFramesPerChannel = pcmData.length / this.channels;

      if (sourceFramesPerChannel === 0) {
        this.pcmBuffer.shift();
        continue;
      }

      // 计算目标帧数：根据采样率比例调整
      let targetFramesPerChannel: number;
      if (this.sampleRate !== this.audioCtx.sampleRate) {
        // 重采样时，目标帧数 = 源帧数 * (目标采样率 / 源采样率)
        const resampleRatio = this.audioCtx.sampleRate / this.sampleRate;
        targetFramesPerChannel = Math.floor(sourceFramesPerChannel * resampleRatio);
      } else {
        // 不需要重采样时，直接使用源帧数
        targetFramesPerChannel = sourceFramesPerChannel;
      }

      // 使用AudioContext的采样率创建AudioBuffer
      // 这样可以避免浏览器进行额外的重采样，确保音频质量
      const audioBuffer = this.audioCtx.createBuffer(
        this.channels,
        targetFramesPerChannel,
        this.audioCtx.sampleRate,
      );

      for (let channel = 0; channel < this.channels; channel++) {
        const channelData = audioBuffer.getChannelData(channel);

        // 根据bitDepth计算最大振幅值
        const bitDepth = this.metadata?.bitDepth || 16;
        const maxAmplitude = Math.pow(2, bitDepth - 1);

        // 计算实际的源数据长度（每个声道的帧数）
        const sourceFrames = sourceFramesPerChannel;

        // 如果原始采样率与AudioContext采样率不同，需要进行重采样
        if (this.sampleRate !== this.audioCtx.sampleRate) {
          // 计算重采样比例：源采样率 / 目标采样率
          const ratio = this.sampleRate / this.audioCtx.sampleRate;

          // 线性插值重采样
          for (let i = 0; i < targetFramesPerChannel; i++) {
            // 计算源数据中的对应位置
            const srcPos = i * ratio;
            const srcIndex = Math.floor(srcPos);

            if (srcIndex < sourceFrames - 1) {
              // 线性插值
              const fraction = srcPos - srcIndex;
              const sample1 = pcmData[srcIndex * this.channels + channel];
              const sample2 = pcmData[(srcIndex + 1) * this.channels + channel];
              const interpolatedSample = sample1 * (1 - fraction) + sample2 * fraction;

              // 对PCM数据进行轻微的音量衰减，避免限幅器过载
              channelData[i] = (interpolatedSample / maxAmplitude) * 0.8;
            } else if (srcIndex < sourceFrames) {
              // 直接使用最后一个样本
              const sampleValue = pcmData[srcIndex * this.channels + channel];
              channelData[i] = (sampleValue / maxAmplitude) * 0.8;
            } else {
              channelData[i] = 0;
            }
          }
        } else {
          // 直接复制PCM数据
          for (let i = 0; i < targetFramesPerChannel; i++) {
            if (i < sourceFrames) {
              const sampleValue = pcmData[i * this.channels + channel];
              // 对PCM数据进行轻微的音量衰减，避免限幅器过载
              channelData[i] = (sampleValue / maxAmplitude) * 0.8;
            } else {
              channelData[i] = 0;
            }
          }
        }
      }

      const source = this.audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      // 对于DSD音频，不需要调整播放速度
      // 因为我们已经在创建AudioBuffer时使用了正确的采样率
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

        // 当一个源播放结束时，检查是否还有缓冲数据需要播放
        if (this.pcmBuffer.length > 0 && this.playerState === "playing") {
          this.playBufferedData();
        } else if (
          this.activeSources.length === 0 &&
          this.pcmBuffer.length === 0 &&
          !this.isReading
        ) {
          this.playerState = "ended";
          this.dispatch("ended");
        }
      };
    }
  }

  private async startReading(): Promise<void> {
    if (!this.isReading || !this.decodeId) return;

    try {
      while (this.isReading && this.bufferedDuration < HIGH_WATER_MARK) {
        const result = await window.electron.ipcRenderer.invoke(
          "ffmpeg-decode:read",
          this.decodeId,
          65536,
        );

        if (!result.success) {
          this.isReading = false;
          break;
        }

        if (result.data) {
          const binaryString = atob(result.data);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          const pcmData = new Int16Array(bytes.buffer);
          this.pcmBuffer.push(pcmData);
          // pcmData.length 是总采样数（包括所有声道）
          // 缓冲时长 = 总采样数 / 声道数 / 采样率
          // 使用实际的音频数据采样率来计算缓冲时长
          // 使用原始音频的采样率计算缓冲时长，确保播放速度正确
          this.bufferedDuration += pcmData.length / this.channels / this.sampleRate;
        }

        if (result.done) {
          this.isReading = false;
          break;
        }
      }

      if (this.isReading && this.bufferedDuration < LOW_WATER_MARK) {
        setTimeout(() => this.startReading(), 0);
      }
    } catch {
      this.isReading = false;
    }
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
        // 忽略错误，继续播放
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
