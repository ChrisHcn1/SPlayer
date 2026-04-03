import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { LocalMusicDB, type MusicTrack } from "../database/LocalMusicDB";
import { processLog } from "../logger";
import { useStore } from "../store";
import { parseFile } from "music-metadata";
import type { Options as GlobOptions } from "fast-glob/out/settings";
import FastGlob from "fast-glob";
import pLimit from "p-limit";
import { getFileID } from "../utils/helper";
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";

/**
 * 获取全局搜索配置
 * @param cwd 当前工作目录
 */
const globOpt = (cwd?: string): GlobOptions => ({
  cwd,
  caseSensitiveMatch: false,
});

/** 本地音乐服务 */
export class LocalMusicService {
  /** 数据库实例 */
  private db: LocalMusicDB | null = null;
  /** 运行锁：防止并发扫描 */
  private isRefreshing = false;
  /** 初始化 Promise：确保只初始化一次 */
  private initPromise: Promise<void> | null = null;
  /** 记录最后一次使用的 DB 路径 */
  private lastDbPath: string = "";

  /** 获取动态路径 */
  get paths() {
    const store = useStore();
    const localCachePath = join(store.get("cachePath"), "local-data");
    return {
      dbPath: join(localCachePath, "library.db"),
      jsonPath: join(localCachePath, "library.json"),
      coverDir: join(localCachePath, "covers"),
      cacheDir: localCachePath,
    };
  }

  /** 初始化 */
  private async ensureInitialized(): Promise<void> {
    const { dbPath, jsonPath, coverDir } = this.paths;
    // 如果路径变了，强制重新初始化
    if (this.lastDbPath && this.lastDbPath !== dbPath) {
      this.initPromise = null;
      if (this.db) {
        this.db.close();
        this.db = null;
      }
    }
    this.lastDbPath = dbPath;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      if (!existsSync(coverDir)) {
        await mkdir(coverDir, { recursive: true });
      }
      if (!this.db) {
        this.db = new LocalMusicDB(dbPath);
        this.db.init();
      }
      await this.db.migrateFromJsonIfNeeded(jsonPath);
    })();
    return this.initPromise;
  }

  /**
   * 使用 ffprobe 获取音频文件元数据
   * @param filePath 文件路径
   * @returns 元数据对象
   */
  private async getMetadataWithFFprobe(filePath: string): Promise<{
    title?: string;
    artist?: string;
    album?: string;
    duration: number;
  } | null> {
    return new Promise((resolve) => {
      try {
        // 查找 ffprobe.exe
        const possiblePaths = [
          // 开发环境路径
          path.join(process.cwd(), "ffmpeg", "bin", "ffprobe.exe"),
          path.join(process.cwd(), "ffmpeg", "ffprobe.exe"),
          path.join(__dirname, "..", "..", "ffmpeg", "bin", "ffprobe.exe"),
          path.join(__dirname, "..", "..", "ffmpeg", "ffprobe.exe"),
          // 打包环境路径
          path.join(process.resourcesPath, "ffmpeg", "bin", "ffprobe.exe"),
          path.join(process.resourcesPath, "ffmpeg", "ffprobe.exe"),
        ];

        let ffprobePath: string | null = null;
        for (const p of possiblePaths) {
          if (fs.existsSync(p)) {
            ffprobePath = p;
            break;
          }
        }

        if (!ffprobePath) {
          resolve(null);
          return;
        }

        const args = [
          "-v",
          "error",
          "-show_entries",
          "format_tags=title,artist,album",
          "-show_entries",
          "format=duration",
          "-of",
          "json",
          filePath,
        ];

        const proc = spawn(ffprobePath, args, {
          env: {
            ...process.env,
            FFPROBE_FORCE_UTF8: "1",
            LANG: "zh_CN.UTF-8",
            LC_ALL: "zh_CN.UTF-8",
          },
        });
        let output = "";

        proc.stdout.on("data", (data) => {
          output += data.toString();
        });

        proc.on("close", (code) => {
          if (code === 0) {
            try {
              const result = JSON.parse(output);
              const metadata: {
                title?: string;
                artist?: string;
                album?: string;
                duration: number;
              } = { duration: 0 };

              if (result.format) {
                if (result.format.duration) {
                  metadata.duration = parseFloat(result.format.duration) * 1000;
                }
                if (result.format.tags) {
                  const tags = result.format.tags;
                  metadata.title = tags.title || tags.TITLE || tags.Title;
                  metadata.artist = tags.artist || tags.ARTIST || tags.Artist;
                  metadata.album = tags.album || tags.ALBUM || tags.Album;
                }
              }

              resolve(metadata);
            } catch {
              resolve(null);
            }
          } else {
            resolve(null);
          }
        });

        proc.on("error", () => {
          resolve(null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  /**
   * 内部扫描方法
   * @param dirPaths 文件夹路径数组
   * @param ignoreDelete 是否忽略删除操作（默认为 false）
   * @param onProgress 进度回调
   * @param onTracksBatch 批量track回调
   */
  private async _scan(
    dirPaths: string[],
    ignoreDelete: boolean = false,
    onProgress?: (current: number, total: number) => void,
    onTracksBatch?: (tracks: MusicTrack[]) => void,
  ) {
    // 运行锁
    if (this.isRefreshing) {
      throw new Error("SCAN_IN_PROGRESS");
    }
    // 确保初始化完成
    await this.ensureInitialized();
    if (!this.db) throw new Error("DB not initialized");
    if (!dirPaths || dirPaths.length === 0) {
      if (!ignoreDelete) {
        this.db.clearTracks();
      }
      return;
    }
    this.isRefreshing = true;
    try {
      // 强制使用备用扫描方案，确保所有音频文件都能被扫描到
      processLog.warn("[LocalMusicService] 强制使用备用扫描方案");
      await this.scanWithFallback(dirPaths, ignoreDelete, onProgress, onTracksBatch);
      return;

      /* 暂时禁用原生工具扫描，因为它可能导致某些文件没有被扫描到
      // 检查工具是否可用
      if (!tools) {
        processLog.warn("[LocalMusicService] 原生工具未加载，使用备用扫描方案");
        await this.scanWithFallback(dirPaths, ignoreDelete, onProgress, onTracksBatch);
        return;
      }
      
      console.time("RustScanStream");
      await new Promise<void>((resolve, reject) => {
        tools
          .scanMusicLibrary(dbPath, dirPaths, coverDir, (err, event) => {
            if (err) {
              processLog.error("[LocalMusicService] 原生模块扫描时出错:", err);
              // 原生工具扫描出错，使用备用扫描方案
              processLog.warn("[LocalMusicService] 原生工具扫描出错，切换到备用扫描方案");
              this.scanWithFallback(dirPaths, ignoreDelete, onProgress, onTracksBatch).then(resolve).catch(reject);
              return;
            }
            if (!event) return;
            // 处理事件
            try {
              switch (event.event) {
                // 进度更新
                case "progress":
                  if (event.progress) {
                    onProgress?.(event.progress.current, event.progress.total);
                  }
                  break;
                // 批量数据
                case "batch":
                  if (event.tracks && event.tracks.length > 0) {
                    this.db?.addTracks(event.tracks);
                    onTracksBatch?.(event.tracks);
                  }
                  break;
                // 扫描结束
                case "end":
                  if (!ignoreDelete && event.deletedPaths && event.deletedPaths.length > 0) {
                    this.db?.deleteTracks(event.deletedPaths);
                  }
                  resolve();
                  break;
              }
            } catch (e) {
              processLog.error("[LocalMusicService] 扫描时出错:", e);
              // 处理事件时出错，使用备用扫描方案
              processLog.warn("[LocalMusicService] 处理扫描事件时出错，切换到备用扫描方案");
              this.scanWithFallback(dirPaths, ignoreDelete, onProgress, onTracksBatch).then(resolve).catch(reject);
            }
          })
          .catch((err) => {
            processLog.error("[LocalMusicService] 原生模块执行出错:", err);
            // 原生工具执行出错，使用备用扫描方案
            processLog.warn("[LocalMusicService] 原生工具执行出错，切换到备用扫描方案");
            this.scanWithFallback(dirPaths, ignoreDelete, onProgress, onTracksBatch).then(resolve).catch(reject);
          });
      });
      console.timeEnd("RustScanStream");
      */
    } catch (err) {
      processLog.error("[LocalMusicService]: 扫描失败", err);
      // 扫描失败，使用备用扫描方案
      processLog.warn("[LocalMusicService] 扫描失败，切换到备用扫描方案");
      await this.scanWithFallback(dirPaths, ignoreDelete, onProgress, onTracksBatch);
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * 备用扫描方案（使用 music-metadata）
   * @param dirPaths 文件夹路径数组
   * @param ignoreDelete 是否忽略删除操作
   * @param onProgress 进度回调
   * @param onTracksBatch 批量track回调
   */
  private async scanWithFallback(
    dirPaths: string[],
    ignoreDelete: boolean = false,
    onProgress?: (current: number, total: number) => void,
    onTracksBatch?: (tracks: MusicTrack[]) => void,
  ) {
    if (!this.db) throw new Error("DB not initialized");

    processLog.info("[LocalMusicService] 使用备用扫描方案开始扫描");

    const allTracks: MusicTrack[] = [];
    let totalFiles = 0;
    let processedFiles = 0;

    // 支持所有音频文件格式，不进行格式限制
    // 扫描所有目录
    for (const dirPath of dirPaths) {
      try {
        processLog.info(`[LocalMusicService] 扫描目录: ${dirPath}`);

        // 使用 FastGlob 查找所有可能的音频文件
        const { stat } = await import("node:fs/promises");
        const { basename, extname } = await import("node:path");

        // 查找所有常见的音频文件格式
        const musicFiles = await FastGlob(
          [
            "**/*.mp3",
            "**/*.wav",
            "**/*.flac",
            "**/*.aac",
            "**/*.webm",
            "**/*.m4a",
            "**/*.ogg",
            "**/*.aiff",
            "**/*.aif",
            "**/*.aifc",
            "**/*.opus",
            "**/*.ape",
            "**/*.dts",
            "**/*.dsd",
            "**/*.dsf",
            "**/*.dff",
            "**/*.wv",
            "**/*.tak",
            "**/*.tta",
            "**/*.mpc",
            "**/*.ac3",
            "**/*.thd",
            "**/*.truehd",
            "**/*.mka",
            "**/*.mkv",
            "**/*.mp4",
            "**/*.m4v",
            "**/*.mov",
            "**/*.asf",
            "**/*.amr",
            "**/*.au",
            "**/*.ra",
            "**/*.rm",
            "**/*.3gp",
            "**/*.mid",
            "**/*.midi",
            "**/*.mod",
            "**/*.it",
            "**/*.s3m",
            "**/*.xm",
          ],
          globOpt(dirPath),
        );

        totalFiles += musicFiles.length;
        processLog.info(`[LocalMusicService] 在 ${dirPath} 中找到 ${musicFiles.length} 个音乐文件`);

        // 限制并发数
        const limit = pLimit(10);

        // 解析元数据
        const metadataPromises = musicFiles.map((file: string) =>
          limit(async () => {
            const fullPath =
              dirPath.endsWith("/") || dirPath.endsWith("\\")
                ? dirPath + file
                : dirPath + (process.platform === "win32" ? "\\" : "/") + file;

            try {
              const fileStat = await stat(fullPath);
              const ext = extname(fullPath);

              // 尝试使用 music-metadata 解析文件
              try {
                const { common, format } = await parseFile(fullPath, { skipCovers: true });

                const track: MusicTrack = {
                  id: String(getFileID(fullPath)),
                  path: fullPath,
                  title: common.title || basename(fullPath, ext),
                  artist: common.artists?.[0] || common.artist || "未知艺术家",
                  album: common.album || "未知专辑",
                  duration: (format?.duration ?? 0) * 1000,
                  mtime: fileStat.mtimeMs,
                  size: fileStat.size,
                  bitrate: format?.bitrate ?? 0,
                };

                processedFiles++;
                if (onProgress) {
                  onProgress(processedFiles, totalFiles);
                }

                return track;
              } catch {
                // 对于任何元数据解析错误，尝试使用 ffprobe 获取元数据
                processLog.info(
                  `[LocalMusicService] music-metadata 解析失败，尝试使用 ffprobe: ${fullPath}`,
                );

                const ffprobeMetadata = await this.getMetadataWithFFprobe(fullPath);

                if (ffprobeMetadata && (ffprobeMetadata.title || ffprobeMetadata.artist)) {
                  // 使用 ffprobe 获取的元数据
                  const track: MusicTrack = {
                    id: String(getFileID(fullPath)),
                    path: fullPath,
                    title: ffprobeMetadata.title || basename(fullPath, ext),
                    artist: ffprobeMetadata.artist || "未知艺术家",
                    album: ffprobeMetadata.album || "未知专辑",
                    duration: ffprobeMetadata.duration,
                    mtime: fileStat.mtimeMs,
                    size: fileStat.size,
                    bitrate: 0,
                  };

                  processedFiles++;
                  if (onProgress) {
                    onProgress(processedFiles, totalFiles);
                  }

                  return track;
                }

                // 使用基本元数据
                processLog.info(`[LocalMusicService] 使用基本元数据: ${fullPath}`);

                const track: MusicTrack = {
                  id: String(getFileID(fullPath)),
                  path: fullPath,
                  title: basename(fullPath, ext),
                  artist: "未知艺术家",
                  album: "未知专辑",
                  duration: 0,
                  mtime: fileStat.mtimeMs,
                  size: fileStat.size,
                  bitrate: 0,
                };

                processedFiles++;
                if (onProgress) {
                  onProgress(processedFiles, totalFiles);
                }

                return track;
              }
            } catch (err) {
              processLog.warn(`[LocalMusicService] 处理文件失败: ${fullPath}`, err);
              return null;
            }
          }),
        );

        const tracks = await Promise.all(metadataPromises);
        const validTracks = tracks.filter((t): t is MusicTrack => t !== null);
        allTracks.push(...validTracks);

        // 批量添加到数据库
        if (validTracks.length > 0) {
          this.db.addTracks(validTracks);
          onTracksBatch?.(validTracks);
        }
      } catch (err) {
        processLog.error(`[LocalMusicService] 扫描目录失败: ${dirPath}`, err);
      }
    }

    // 如果不忽略删除，清理不存在的文件
    if (!ignoreDelete && allTracks.length > 0) {
      const allPaths = new Set(allTracks.map((t) => t.path));
      const existingTracks = this.db.getAllTracks();
      const deletedPaths = existingTracks.filter((t) => !allPaths.has(t.path)).map((t) => t.path);

      if (deletedPaths.length > 0) {
        this.db.deleteTracks(deletedPaths);
        processLog.info(`[LocalMusicService] 删除了 ${deletedPaths.length} 个不存在的文件`);
      }
    }

    processLog.info(`[LocalMusicService] 备用扫描完成，共扫描 ${allTracks.length} 个文件`);
  }

  /**
   * 刷新所有库文件夹
   * @param dirPaths 文件夹路径数组
   * @param onProgress 进度回调
   * @param onTracksBatch 批量track回调
   */
  async refreshLibrary(
    dirPaths: string[],
    onProgress?: (current: number, total: number) => void,
    onTracksBatch?: (tracks: MusicTrack[]) => void,
  ) {
    await this._scan(dirPaths, false, onProgress, onTracksBatch);
    return this.db?.getAllTracks() || [];
  }

  /**
   * 扫描指定目录
   * @param dirPath 目录路径
   */
  async scanDirectory(dirPath: string): Promise<MusicTrack[]> {
    await this._scan([dirPath], true);
    return this.db?.getTracksInPath(dirPath) || [];
  }

  /** 获取所有歌曲 */
  async getAllTracks(): Promise<MusicTrack[]> {
    await this.ensureInitialized();
    if (!this.db) return [];
    return this.db.getAllTracks();
  }

  /** 获取音频分析结果 */
  async getAnalysis(path: string) {
    await this.ensureInitialized();
    return this.db?.getAnalysis(path);
  }

  /** 保存音频分析结果 */
  async saveAnalysis(path: string, data: string, mtime: number, size: number) {
    await this.ensureInitialized();
    this.db?.saveAnalysis(path, data, mtime, size);
  }
}
