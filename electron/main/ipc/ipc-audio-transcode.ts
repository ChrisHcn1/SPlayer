import { ipcMain } from "electron";
import { ipcLog } from "../logger";
import audioTranscodeService from "../services/AudioTranscodeService";

const initAudioTranscodeIpc = (): void => {
  ipcMain.handle("audio-transcode-check-ffmpeg", async () => {
    try {
      const available = await audioTranscodeService.isFFmpegAvailable();
      return { success: true, available };
    } catch (error) {
      ipcLog.error("[AudioTranscode] FFmpeg check failed:", error);
      return { success: false, available: false, error: String(error) };
    }
  });

  ipcMain.handle(
    "audio-transcode",
    async (event, sourcePath: string, targetFormat: string = "flac") => {
      try {
        const onProgress = (progress: number) => {
          event.sender.send("audio-transcode-progress", {
            sourcePath,
            targetFormat,
            progress,
          });
        };

        const result = await audioTranscodeService.transcodeAudio(
          sourcePath,
          targetFormat,
          onProgress,
        );

        return result;
      } catch (error) {
        ipcLog.error("[AudioTranscode] Transcoding failed:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle("audio-transcode-status", async (_, sourcePath: string, targetFormat: string) => {
    try {
      const status = audioTranscodeService.getJobStatus(sourcePath, targetFormat);
      return { success: true, status };
    } catch (error) {
      ipcLog.error("[AudioTranscode] Status check failed:", error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle("audio-transcode-cancel", async (_, sourcePath: string, targetFormat: string) => {
    try {
      const cancelled = audioTranscodeService.cancelTranscode(sourcePath, targetFormat);
      return { success: true, cancelled };
    } catch (error) {
      ipcLog.error("[AudioTranscode] Cancel failed:", error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle("audio-transcode-cleanup", async (_, olderThanMs?: number) => {
    try {
      const deletedCount = await audioTranscodeService.cleanupCache(olderThanMs);
      return { success: true, deletedCount };
    } catch (error) {
      ipcLog.error("[AudioTranscode] Cleanup failed:", error);
      return { success: false, error: String(error) };
    }
  });

  ipcLog.info("[AudioTranscode] Audio transcode IPC initialized");
};

export default initAudioTranscodeIpc;
