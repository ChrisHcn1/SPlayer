import type { IExtendedAudioContext } from "./BaseAudioPlayer";

let sharedContext: IExtendedAudioContext | null = null;
let masterInput: GainNode | null = null;
let masterLimiter: DynamicsCompressorNode | null = null;

export const getSharedAudioContext = (): IExtendedAudioContext => {
  if (!sharedContext) {
    const AudioContextClass =
      window.AudioContext ||
      (
        window as unknown as {
          webkitAudioContext: typeof AudioContext;
        }
      ).webkitAudioContext;

    // 尝试使用更高的采样率，优先选择 88200Hz 或 48000Hz
    const options: AudioContextOptions = {};

    // 检查浏览器是否支持指定采样率
    if (typeof AudioContextClass !== "undefined") {
      // 尝试多种方法获取支持的采样率
      let supportedRates: number[] = [];

      // 方法1: 使用静态方法 getSupportedSampleRates()
      if ("getSupportedSampleRates" in AudioContextClass) {
        supportedRates = (AudioContextClass as any).getSupportedSampleRates();
        console.log(
          "[SharedAudioContext] Supported sample rates (from getSupportedSampleRates):",
          supportedRates,
        );
      }
      // 方法2: 创建临时AudioContext并检查实际采样率
      else {
        console.log(
          "[SharedAudioContext] getSupportedSampleRates not available, testing sample rates...",
        );

        // 测试常见的采样率，包括DSD的高采样率
        const testRates = [2822400, 5644800, 11289600, 176400, 88200, 48000, 44100];
        for (const rate of testRates) {
          try {
            const tempCtx = new AudioContextClass({ sampleRate: rate });
            if (tempCtx.sampleRate === rate) {
              supportedRates.push(rate);
              console.log(`[SharedAudioContext] Sample rate ${rate}Hz is supported`);
            }
            tempCtx.close();
          } catch (e) {
            console.log(`[SharedAudioContext] Sample rate ${rate}Hz is not supported:`, e);
          }
        }
      }

      // 优先选择DSD的高采样率
      if (supportedRates.includes(11289600)) {
        options.sampleRate = 11289600;
        console.log("[SharedAudioContext] Using 11289600Hz sample rate (DSD256)");
      } else if (supportedRates.includes(5644800)) {
        options.sampleRate = 5644800;
        console.log("[SharedAudioContext] Using 5644800Hz sample rate (DSD128)");
      } else if (supportedRates.includes(2822400)) {
        options.sampleRate = 2822400;
        console.log("[SharedAudioContext] Using 2822400Hz sample rate (DSD64)");
      }
      // 其次选择 176400Hz
      else if (supportedRates.includes(176400)) {
        options.sampleRate = 176400;
        console.log("[SharedAudioContext] Using 176400Hz sample rate");
      }
      // 然后选择 88200Hz
      else if (supportedRates.includes(88200)) {
        options.sampleRate = 88200;
        console.log("[SharedAudioContext] Using 88200Hz sample rate");
      }
      // 然后选择 48000Hz
      else if (supportedRates.includes(48000)) {
        options.sampleRate = 48000;
        console.log("[SharedAudioContext] Using 48000Hz sample rate");
      }
      // 最后使用默认采样率
      else {
        console.log("[SharedAudioContext] Using default sample rate");
      }

      // 不强制使用固定采样率，而是使用检测到的最高支持的采样率
      console.log(
        "[SharedAudioContext] Using detected highest supported sample rate for DSD playback",
      );
    } else {
      console.log("[SharedAudioContext] AudioContext not available");
    }

    sharedContext = new AudioContextClass(options) as IExtendedAudioContext;
    console.log("[SharedAudioContext] Created with sample rate:", sharedContext.sampleRate);
  }
  return sharedContext;
};

export const getSharedMasterInput = (): GainNode => {
  const ctx = getSharedAudioContext();
  if (!masterInput) {
    masterInput = ctx.createGain();
    masterLimiter = ctx.createDynamicsCompressor();

    masterLimiter.threshold.value = -6;
    masterLimiter.knee.value = 40;
    masterLimiter.ratio.value = 12;
    masterLimiter.attack.value = 0.003;
    masterLimiter.release.value = 0.25;

    masterInput.connect(masterLimiter);
    masterLimiter.connect(ctx.destination);
  }
  return masterInput;
};

export const getSharedMasterLimiter = (): DynamicsCompressorNode | null => {
  return masterLimiter;
};
