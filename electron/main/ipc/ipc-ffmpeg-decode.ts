import { ipcMain } from "electron";
import { ipcLog } from "../logger";
import { ffmpegAudioDecodeService, default as FFmpegAudioDecodeService } from "../services/FFmpegAudioDecodeService";
import { Readable } from "node:stream";

/**
 * FFmpeg 音频解码 IPC 处理器
 * 
 * 提供实时音频解码功能，用于播放原生不支持的音频格式
 */

// 存储活跃的解码会话
const activeDecodes = new Map<string, {
  stream: Readable;
  cleanup: () => void;
}>();

export function initFFmpegDecodeIPC() {
  ipcLog.info("[FFmpegDecodeIPC] Initializing FFmpeg decode IPC handlers...");

  /**
   * 检查音频格式是否需要 FFmpeg 解码
   */
  ipcMain.handle("ffmpeg-decode:needs-decode", async (_, filePath: string) => {
    return FFmpegAudioDecodeService.needsFFmpegDecode(filePath);
  });

  /**
   * 获取音频文件的元数据
   */
  ipcMain.handle("ffmpeg-decode:get-metadata", async (_, filePath: string) => {
    try {
      const metadata = await ffmpegAudioDecodeService.getMetadata(filePath);
      return { success: true, metadata };
    } catch (error) {
      ipcLog.error("[FFmpegDecodeIPC] Failed to get metadata:", error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * 开始音频解码
   * 返回一个可读流，用于获取 PCM 数据
   */
  ipcMain.handle("ffmpeg-decode:start", async (_, filePath: string) => {
    try {
      const decodeId = `decode-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      const decodeStream = await ffmpegAudioDecodeService.startDecode({
        sourcePath: filePath,
        sampleFormat: "s16le",
        sampleRate: 48000,
        channels: 2,
      });

      // 存储解码会话
      activeDecodes.set(decodeId, {
        stream: decodeStream.pcmStream as Readable,
        cleanup: () => {
          ffmpegAudioDecodeService.stopDecode(decodeStream);
          activeDecodes.delete(decodeId);
        },
      });

      ipcLog.info(`[FFmpegDecodeIPC] Started decode session: ${decodeId}`);

      return {
        success: true,
        decodeId,
        metadata: decodeStream.metadata,
      };
    } catch (error) {
      ipcLog.error("[FFmpegDecodeIPC] Failed to start decode:", error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * 读取解码后的 PCM 数据
   */
  ipcMain.handle("ffmpeg-decode:read", async (_, decodeId: string, chunkSize: number = 65536) => {
    const session = activeDecodes.get(decodeId);
    if (!session) {
      return { success: false, error: "Decode session not found" };
    }

    try {
      const chunk = session.stream.read(chunkSize);
      if (chunk) {
        return { success: true, data: Buffer.from(chunk).toString("base64"), done: false };
      } else {
        // 如果没有数据可读，等待一下再试
        return { success: true, data: null, done: false };
      }
    } catch (error) {
      ipcLog.error(`[FFmpegDecodeIPC] Failed to read from decode session ${decodeId}:`, error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * 停止音频解码
   */
  ipcMain.handle("ffmpeg-decode:stop", async (_, decodeId: string) => {
    const session = activeDecodes.get(decodeId);
    if (session) {
      session.cleanup();
      ipcLog.info(`[FFmpegDecodeIPC] Stopped decode session: ${decodeId}`);
      return { success: true };
    }
    return { success: false, error: "Decode session not found" };
  });

  /**
   * 清理所有活跃的解码会话
   */
  ipcMain.handle("ffmpeg-decode:cleanup", async () => {
    for (const [decodeId, session] of activeDecodes) {
      session.cleanup();
      ipcLog.info(`[FFmpegDecodeIPC] Cleaned up decode session: ${decodeId}`);
    }
    activeDecodes.clear();
    return { success: true };
  });

  ipcLog.info("[FFmpegDecodeIPC] FFmpeg decode IPC handlers initialized");
}
