import { useSettingStore } from "@/stores";
import { checkIsolationSupport, isElectron } from "@/utils/env";
import { TypedEventTarget } from "@/utils/TypedEventTarget";
import { AudioElementPlayer } from "../audio-player/AudioElementPlayer";
import { AUDIO_EVENTS, type AudioEventMap } from "../audio-player/BaseAudioPlayer";
import { FFmpegAudioPlayer } from "../audio-player/ffmpeg-engine/FFmpegAudioPlayer";

import { SystemFfmpegAudioPlayer } from "../audio-player/SystemFfmpegAudioPlayer";
import { FFplayAudioPlayer } from "../audio-player/FFplayAudioPlayer";
import type {
  EngineCapabilities,
  FadeCurve,
  IPlaybackEngine,
  PauseOptions,
  PlayOptions,
  AutomationPoint,
} from "../audio-player/IPlaybackEngine";
import { MpvPlayer, useMpvPlayer } from "../audio-player/MpvPlayer";
import { getSharedAudioContext } from "../audio-player/SharedAudioContext";

/**
 * 音频管理器
 *
 * 统一的音频播放接口，根据设置选择播放引擎
 */
class AudioManager extends TypedEventTarget<AudioEventMap> implements IPlaybackEngine {
  /** 当前活动的播放引擎 */
  private engine!: IPlaybackEngine;
  /** 待切换的播放引擎 (Crossfade 期间) */
  private pendingEngine: IPlaybackEngine | null = null;
  /** 切换引擎的定时器 */
  private pendingSwitchTimer: ReturnType<typeof setTimeout> | null = null;
  /** 用于清理当前引擎的事件监听器 */
  private cleanupListeners: (() => void) | null = null;
  /** 是否正在进行 Crossfade (避免事件干扰) */
  private isCrossfading: boolean = false;

  /** 主音量 (用于 Crossfade 初始化) */
  private _masterVolume: number = 1.0;

  /** 当前引擎类型：element | ffmpeg | mpv | ffmpeg-binary | system-ffmpeg | ffplay */
  public engineType!: "element" | "ffmpeg" | "mpv" | "ffmpeg-binary" | "system-ffmpeg" | "ffplay";

  /** 引擎能力描述 */
  public capabilities!: EngineCapabilities;

  /** 音频引擎配置 */
  private playbackEngine: "web-audio" | "mpv";
  private audioEngine: "element" | "ffmpeg";

  constructor(playbackEngine: "web-audio" | "mpv", audioEngine: "element" | "ffmpeg") {
    super();

    this.playbackEngine = playbackEngine;
    this.audioEngine = audioEngine;

    // 初始化默认引擎
    this.initializeDefaultEngine();
  }

  /**
   * 初始化默认引擎
   */
  private initializeDefaultEngine() {
    if (isElectron && this.playbackEngine === "mpv") {
      const mpvPlayer = useMpvPlayer();
      mpvPlayer.init();
      this.engine = mpvPlayer;
      this.engineType = "mpv";
    } else if (this.audioEngine === "ffmpeg" && checkIsolationSupport()) {
      this.engine = new FFmpegAudioPlayer();
      this.engineType = "ffmpeg";
    } else {
      if (this.audioEngine === "ffmpeg" && !checkIsolationSupport()) {
        console.warn("[AudioManager] 环境未隔离，从 FFmpeg 回退到 Web Audio");
      }

      this.engine = new AudioElementPlayer();
      this.engineType = "element";
    }

    this.capabilities = this.engine.capabilities;
    this.bindEngineEvents();
  }

  /**
   * 检查并切换到 FFplay 解码引擎
   */
  public async checkAndSwitchToFFmpegBinary(url: string): Promise<boolean> {
    try {
      // 检查文件扩展名，对于DSD、APE、DTS等格式，直接使用ffplay
      const ext = url.toLowerCase().split(".").pop();
      const ffplayFormats = ["dts", "dff", "dsf", "ape", "wv", "tak", "tta", "mlp", "thd"];
      const useFFplay = ffplayFormats.includes(ext || "");

      if (useFFplay) {
        // 对于特定格式，使用 FFplay 引擎
        if (this.engineType !== "ffplay") {
          console.log(`[AudioManager] 切换到 FFplay 解码: ${url}`);

          // 清理当前引擎
          this.clearPendingSwitch();
          if (this.cleanupListeners) {
            this.cleanupListeners();
            this.cleanupListeners = null;
          }
          this.engine.destroy();

          // 创建 FFplay 引擎
          this.engine = new FFplayAudioPlayer();
          this.engineType = "ffplay";
          this.capabilities = this.engine.capabilities;
          this.bindEngineEvents();

          return true;
        }
      } else {
        // 不需要 FFplay 解码，切换回默认引擎
        if (this.engineType === "ffplay") {
          console.log(`[AudioManager] 切换回默认引擎: ${url}`);

          // 清理当前引擎
          this.clearPendingSwitch();
          if (this.cleanupListeners) {
            this.cleanupListeners();
            this.cleanupListeners = null;
          }
          this.engine.destroy();

          // 创建默认引擎
          this.engine = this.createDefaultEngine();
          this.engineType = this.audioEngine === "ffmpeg" ? "ffmpeg" : "element";
          this.capabilities = this.engine.capabilities;
          this.bindEngineEvents();

          return true;
        }
      }

      return false;
    } catch (error) {
      console.error("[AudioManager] 检查 FFplay 解码失败:", error);
      return false;
    }
  }

  /**
   * 创建默认播放引擎
   */
  private createDefaultEngine(): IPlaybackEngine {
    if (this.playbackEngine === "mpv" && useMpvPlayer()) {
      return new MpvPlayer();
    }
    if (this.audioEngine === "ffmpeg" && isElectron) {
      return new FFmpegAudioPlayer();
    }
    return new AudioElementPlayer();
  }

  /**
   * 绑定引擎事件，转发到 AudioManager
   */
  private bindEngineEvents() {
    if (this.cleanupListeners) {
      this.cleanupListeners();
    }

    const events = Object.values(AUDIO_EVENTS);
    const handlers: Map<string, EventListener> = new Map();

    events.forEach((eventType) => {
      const handler = (e: Event) => {
        // [修复] Crossfade 期间屏蔽旧引擎的 pause/ended/error 事件，防止状态误判
        if (
          this.isCrossfading &&
          (eventType === "pause" || eventType === "ended" || eventType === "error")
        ) {
          // 如果是 ended，可能需要特别处理？不，crossfade 期间旧引擎结束是正常的
          // 如果是 error，也应该由新引擎接管，或者通过 promise 抛出
          return;
        }

        const detail = (e as CustomEvent).detail;
        this.dispatch(eventType, detail);
      };
      handlers.set(eventType, handler);
      this.engine.addEventListener(eventType, handler);
    });

    this.cleanupListeners = () => {
      handlers.forEach((handler, eventType) => {
        this.engine.removeEventListener(eventType, handler);
      });
    };
  }

  /**
   * 初始化
   */
  public init(): void {
    this.engine.init();
  }

  /**
   * 销毁引擎
   */
  public destroy(): void {
    this.clearPendingSwitch();
    if (this.cleanupListeners) {
      this.cleanupListeners();
      this.cleanupListeners = null;
    }
    this.engine.destroy();
  }

  /**
   * 加载并播放音频
   */
  public async play(url?: string, options?: PlayOptions): Promise<void> {
    // 检查是否需要切换到 FFmpeg 二进制解码引擎
    if (url && isElectron) {
      await this.checkAndSwitchToFFmpegBinary(url);
    }

    await this.engine.play(url, options);
  }

  /**
   * 交叉淡入淡出到下一首
   * @param url 下一首歌曲 URL
   * @param options 配置
   */
  public async crossfadeTo(
    url: string,
    options: {
      duration: number;
      seek?: number;
      autoPlay?: boolean;
      uiSwitchDelay?: number;
      onSwitch?: () => void;
      mixType?: "default" | "bassSwap";
      rate?: number;
      replayGain?: number;
      fadeCurve?: FadeCurve;
      pitchShift?: number;
      playbackRate?: number;
      automationCurrent?: AutomationPoint[];
      automationNext?: AutomationPoint[];
    },
  ): Promise<void> {
    // MPV 不支持 Web Audio API 级别的 Crossfade，回退到普通播放
    if (this.engineType === "mpv") {
      this.stop();
      if (options.onSwitch) options.onSwitch();
      await this.play(url, {
        autoPlay: options.autoPlay ?? true,
        seek: options.seek,
        fadeIn: true,
        fadeDuration: options.duration,
      });
      return;
    }

    console.log(
      `🔀 [AudioManager] Starting Crossfade (duration: ${options.duration}s, type: ${options.mixType})`,
    );

    // 清理之前的 pending
    this.clearPendingSwitch();
    this.isCrossfading = true;

    // 1. 创建新引擎 (保持同类型)
    let newEngine: IPlaybackEngine;
    if (this.engineType === "ffmpeg") {
      newEngine = new FFmpegAudioPlayer();
    } else if (this.engineType === "system-ffmpeg") {
      newEngine = new SystemFfmpegAudioPlayer();
    } else if (this.engineType === "ffplay") {
      newEngine = new FFplayAudioPlayer();
    } else {
      newEngine = new AudioElementPlayer();
    }

    newEngine.init();
    this.pendingEngine = newEngine;

    // 2. 预设状态
    newEngine.setVolume(0);
    if (this.engine.capabilities.supportsRate) {
      // 优先使用传入的 playbackRate
      const targetRate = options.playbackRate ?? options.rate ?? this.getRate();
      newEngine.setRate(targetRate);
    }

    // Apply Pitch Shift (if supported)
    if (options.pitchShift !== undefined && options.pitchShift !== 0) {
      // TODO: Implement pitch shift in IPlaybackEngine (requires SoundTouch or Detune)
      // For now, Web Audio API 'detune' can be used if exposed
      if (newEngine instanceof AudioElementPlayer || newEngine instanceof FFmpegAudioPlayer) {
        // 暂时无法直接设置 pitch shift，需要在 BaseAudioPlayer 中实现
        // 这里先留空，等待后续实现
      }
    }

    // Apply ReplayGain to new engine
    if (options.replayGain !== undefined) {
      newEngine.setReplayGain?.(options.replayGain);
    }

    // Bass Swap Filter Setup
    if (options.mixType === "bassSwap") {
      this.engine.setHighPassQ?.(1.0);
      newEngine.setHighPassQ?.(1.0);
      newEngine.setHighPassFilter?.(400, 0);
    }

    const fadeCurve = options.fadeCurve ?? "equalPower";

    // 3. 启动新引擎
    await newEngine.play(url, {
      autoPlay: true,
      seek: options.seek,
      fadeIn: false,
    });

    if (newEngine.rampVolumeTo) {
      newEngine.rampVolumeTo(this._masterVolume, options.duration, fadeCurve);
    } else {
      newEngine.setVolume(this._masterVolume);
    }

    // Apply Automation Curves (Mashup Mode)
    if (options.automationCurrent && options.automationNext) {
      // 使用精确的自动化曲线
      const ctx = getSharedAudioContext();
      const startTime = ctx.currentTime;

      // 应用 Current 曲线 (Volume & Filter)
      options.automationCurrent.forEach((point) => {
        if (point.timeOffset >= 0 && point.timeOffset <= options.duration) {
          // Volume
          this.engine.rampVolumeTo?.(point.volume * this._masterVolume, 0.1, "linear"); // 简化处理，实际应使用 rampAt
          // Low Cut (High Pass Filter)
          // DJ EQ Low Cut usually goes up to 200-400Hz.
          // Let's map 0.0 -> 10Hz, 1.0 -> 400Hz
          const targetFreq = point.lowCut * 400;
          this.engine.setHighPassFilter?.(targetFreq, 0.1);
        }
      });

      // 应用 Next 曲线
      options.automationNext.forEach((point) => {
        if (point.timeOffset >= 0 && point.timeOffset <= options.duration) {
          // Volume
          // newEngine 已经有 rampVolumeTo 处理了整体淡入，这里叠加自动化可能冲突
          // 暂时忽略 Next 的 Volume 自动化，依赖 rampVolumeTo

          // Low Cut
          const targetFreq = point.lowCut * 400;
          newEngine.setHighPassFilter?.(targetFreq, 0.1);
        }
      });

      // 调度更精细的自动化需要 setHighPassFilterAt 支持
      if (this.engine.setHighPassFilterAt && newEngine.setHighPassFilterAt) {
        options.automationCurrent.forEach((point) => {
          const t = startTime + point.timeOffset;
          // 映射 low_cut 到频率 (0 -> 10Hz, 1 -> 400Hz)
          const freq = Math.max(10, point.lowCut * 400);
          this.engine.setHighPassFilterAt?.(freq, t);

          // Volume 自动化 (如果需要精确控制)
          // this.engine.setVolumeAt(point.volume, t);
        });

        options.automationNext.forEach((point) => {
          const t = startTime + point.timeOffset;
          const freq = Math.max(10, point.lowCut * 400);
          newEngine.setHighPassFilterAt?.(freq, t);
        });
      }
    } else if (options.mixType === "bassSwap") {
      const mid = options.duration * 0.5;
      const release = Math.min(0.6, options.duration * 0.25);

      const t0 = getSharedAudioContext().currentTime + 0.02;
      const tMid = t0 + mid;
      const tReleaseEnd = tMid + release;
      const tEnd = t0 + options.duration;
      const bypassFreq = 10;

      if (this.engine.setHighPassFilterAt && this.engine.rampHighPassFilterToAt) {
        this.engine.setHighPassFilterAt(bypassFreq, t0);
        this.engine.rampHighPassFilterToAt(400, tMid);
      } else {
        this.engine.setHighPassFilter?.(400, mid);
      }

      if (newEngine.setHighPassFilterAt && newEngine.rampHighPassFilterToAt) {
        newEngine.setHighPassFilterAt(400, t0);
        newEngine.setHighPassFilterAt(400, tMid);
        newEngine.rampHighPassFilterToAt(bypassFreq, tReleaseEnd);
        newEngine.setHighPassFilterAt(bypassFreq, tEnd + 0.05);
      }

      if (newEngine.setHighPassQAt) {
        newEngine.setHighPassQAt(0.707, tEnd + 0.05);
      } else {
        newEngine.setHighPassQ?.(0.707);
      }
    }

    // 4. 旧引擎淡出 (Fade Out, Equal Power, Keep Context)
    const oldEngine = this.engine;
    oldEngine.pause({
      fadeOut: true,
      fadeDuration: options.duration,
      fadeCurve,
      keepContextRunning: true,
    });

    const commitSwitch = () => {
      console.log("🔀 [AudioManager] Committing Crossfade Switch");
      if (this.cleanupListeners) {
        this.cleanupListeners();
        this.cleanupListeners = null;
      }

      this.engine = newEngine;
      this.pendingEngine = null; // Cleared from pending, now active
      this.isCrossfading = false;
      this.bindEngineEvents();

      // 触发 UI 切换回调
      if (options.onSwitch) {
        try {
          options.onSwitch();
        } catch {
          // ignore
        }
      }

      // 触发一次 update 以刷新 UI
      this.dispatch(AUDIO_EVENTS.TIME_UPDATE, undefined);
      this.dispatch(AUDIO_EVENTS.PLAY, undefined);

      if (options.mixType !== "bassSwap") {
        this.engine.setHighPassFilter?.(0, 0);
      }
    };

    const switchDelay = options.uiSwitchDelay ?? 0;

    if (switchDelay > 0) {
      this.pendingSwitchTimer = setTimeout(() => {
        this.pendingSwitchTimer = null;
        commitSwitch();
      }, switchDelay * 1000);
    } else {
      commitSwitch();
    }

    // 销毁旧引擎
    setTimeout(
      () => {
        oldEngine.destroy();
      },
      options.duration * 1000 + 1000,
    );
  }

  /**
   * 恢复播放
   */
  public async resume(options?: { fadeIn?: boolean; fadeDuration?: number }): Promise<void> {
    await this.engine.resume(options);
  }

  /**
   * 暂停音频
   */
  public pause(options?: PauseOptions): void {
    this.engine.pause(options);
  }

  /**
   * 停止播放并将时间重置为 0
   */
  public stop(): void {
    this.clearPendingSwitch();
    this.engine.stop();
  }

  private clearPendingSwitch() {
    if (this.pendingSwitchTimer) {
      clearTimeout(this.pendingSwitchTimer);
      this.pendingSwitchTimer = null;
    }
    this.engine.setHighPassFilter?.(0, 0);
    this.engine.setHighPassQ?.(0.707);
    if (this.pendingEngine) {
      // 如果有待切换引擎，销毁它
      try {
        this.pendingEngine.destroy();
      } catch {
        // ignore
      }
      this.pendingEngine = null;
    }
  }

  /**
   * 跳转到指定时间
   * @param time 时间（秒）
   */
  public seek(time: number): void {
    this.engine.seek(time);
  }

  /**
   * 设置 ReplayGain 增益
   * @param gain 线性增益值
   */
  public setReplayGain(gain: number): void {
    this.engine.setReplayGain?.(gain);
  }

  /**
   * 设置音量
   * @param value 音量值 (0.0 - 1.0)
   */
  public setVolume(value: number): void {
    this._masterVolume = value;
    this.engine.setVolume(value);
  }

  /**
   * 获取当前音量
   */
  public getVolume(): number {
    return this.engine.getVolume();
  }

  /**
   * 设置播放速率
   * @param value 速率 (0.5 - 2.0)
   */
  public setRate(value: number): void {
    this.engine.setRate(value);
  }

  /**
   * 获取当前播放速率
   */
  public getRate(): number {
    return this.engine.getRate();
  }

  /**
   * 设置输出设备
   */
  public async setSinkId(deviceId: string): Promise<void> {
    await this.engine.setSinkId(deviceId);
  }

  /**
   * 获取频谱数据 (用于可视化)
   */
  public getFrequencyData(): Uint8Array {
    return this.engine.getFrequencyData?.() ?? new Uint8Array(0);
  }

  /**
   * 获取低频音量 [0.0-1.0]
   */
  public getLowFrequencyVolume(): number {
    return this.engine.getLowFrequencyVolume?.() ?? 0;
  }

  /**
   * 设置高通滤波器频率
   */
  public setHighPassFilter(frequency: number, rampTime: number = 0): void {
    this.engine.setHighPassFilter?.(frequency, rampTime);
  }

  public setHighPassQ(q: number): void {
    this.engine.setHighPassQ?.(q);
  }

  /**
   * 设置低通滤波器频率
   */
  public setLowPassFilter(frequency: number, rampTime: number = 0): void {
    this.engine.setLowPassFilter?.(frequency, rampTime);
  }

  public setLowPassQ(q: number): void {
    this.engine.setLowPassQ?.(q);
  }

  /**
   * 设置均衡器增益
   */
  public setFilterGain(index: number, value: number): void {
    this.engine.setFilterGain?.(index, value);
  }

  /**
   * 获取当前均衡器设置
   */
  public getFilterGains(): number[] {
    return this.engine.getFilterGains?.() ?? [];
  }

  /**
   * 获取音频总时长（秒）
   */
  public get duration(): number {
    return this.engine.duration;
  }

  /**
   * 获取当前播放时间（秒）
   */
  public get currentTime(): number {
    return this.engine.currentTime;
  }

  /**
   * 获取是否暂停状态
   */
  public get paused(): boolean {
    return this.engine.paused;
  }

  /**
   * 获取当前播放地址
   */
  public get src(): string {
    return this.engine.src;
  }

  /**
   * 获取音频错误码
   */
  public getErrorCode(): number {
    return this.engine.getErrorCode();
  }

  /**
   * 解除 MPV 强制暂停状态
   * 仅在 MPV 引擎下有效
   */
  public clearForcePaused(): void {
    if (this.engine instanceof MpvPlayer) {
      this.engine.clearForcePaused();
    }
  }

  /**
   * 设置 MPV 期望的 Seek 位置
   * 仅在 MPV 引擎下有效
   */
  public setPendingSeek(seconds: number | null): void {
    if (this.engine instanceof MpvPlayer) {
      this.engine.setPendingSeek(seconds);
    }
  }

  /**
   * 切换播放/暂停
   */
  public togglePlayPause(): void {
    if (this.paused) {
      this.resume();
    } else {
      this.pause();
    }
  }
}

const AUDIO_MANAGER_KEY = "__SPLAYER_AUDIO_MANAGER__";

/**
 * 获取 AudioManager 实例
 * @returns AudioManager
 */
export const useAudioManager = (): AudioManager => {
  const win = window as Window & { [AUDIO_MANAGER_KEY]?: AudioManager };
  if (!win[AUDIO_MANAGER_KEY]) {
    const settingStore = useSettingStore();
    win[AUDIO_MANAGER_KEY] = new AudioManager(
      settingStore.playbackEngine,
      settingStore.audioEngine,
    );
    console.log(`[AudioManager] 创建新实例, engine: ${win[AUDIO_MANAGER_KEY].engineType}`);
  }
  return win[AUDIO_MANAGER_KEY];
};
