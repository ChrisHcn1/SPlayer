import type { Options as GlobOptions } from "fast-glob/out/settings";
import { parseFile } from "music-metadata";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { ipcLog } from "../logger";
import { getFileID, getFileMD5, metaDataLyricsArrayToLrc } from "../utils/helper";
import FastGlob from "fast-glob";
import pLimit from "p-limit";

/** 修改音乐元数据的输入参数 */
export interface MusicMetadataInput {
  name?: string;
  artist?: string;
  album?: string;
  alia?: string;
  lyric?: string;
  cover?: string | null;
  albumArtist?: string;
  genre?: string;
  year?: number;
  trackNumber?: number;
  discNumber?: number;
}

/** 支持的音乐文件扩展名列表 */
const MUSIC_EXTENSIONS = [
  "mp3",
  "wav",
  "flac",
  "aac",
  "webm",
  "m4a",
  "ogg",
  "aiff",
  "aif",
  "aifc",
  "opus",
];

/**
 * 获取全局搜索配置
 * @param cwd 当前工作目录
 */
const globOpt = (cwd?: string): GlobOptions => ({
  cwd,
  caseSensitiveMatch: false,
});

export class MusicMetadataService {
  /**
   * 扫描指定目录下的所有音乐文件并获取元数据
   * @param dirPath 目录路径
   * @returns 音乐文件元数据列表
   */
  async scanDirectory(dirPath: string) {
    try {
      // 校验路径有效性
      if (!dirPath || dirPath.trim() === "") {
        ipcLog.warn("⚠️ Empty directory path provided, skipping");
        return [];
      }
      // 规范化路径
      const filePath = resolve(dirPath).replace(/\\/g, "/");
      // 检查目录是否存在
      try {
        await access(filePath);
      } catch {
        ipcLog.warn(`⚠️ Directory not accessible: ${filePath}`);
        return [];
      }
      console.info(`📂 Fetching music files from: ${filePath}`);

      // 查找指定目录下的所有音乐文件
      const musicFiles = await FastGlob(`**/*.{${MUSIC_EXTENSIONS.join(",")}}`, globOpt(filePath));

      // 限制并发数
      const limit = pLimit(10);

      // 解析元信息（使用 allSettled 防止单个文件失败影响整体）
      const metadataPromises = musicFiles.map((file) =>
        limit(async () => {
          const fullPath = join(dirPath, file);
          try {
            // 处理元信息 (跳过封面解析以提升速度)
            const { common, format } = await parseFile(fullPath, { skipCovers: true });
            // 获取文件状态信息（大小和创建时间）
            const fileStat = await stat(fullPath);
            const ext = extname(fullPath);

            return {
              id: getFileID(fullPath),
              name: common.title || basename(fullPath, ext),
              artists: common.artists?.[0] || common.artist,
              album: common.album || "",
              alia: common.comment?.[0]?.text || "",
              duration: (format?.duration ?? 0) * 1000,
              size: (fileStat.size / (1024 * 1024)).toFixed(2),
              path: fullPath,
              quality: format.bitrate ?? 0,
              // 文件创建时间（用于排序）
              createTime: fileStat.birthtime.getTime(),
              replayGain: {
                trackGain: common.replaygain_track_gain?.ratio,
                trackPeak: common.replaygain_track_peak?.ratio,
                albumGain: common.replaygain_album_gain?.ratio,
                albumPeak: common.replaygain_album_peak?.ratio,
              },
            };
          } catch (err: any) {
            if (err.message && err.message.includes("FourCC contains invalid characters")) {
              ipcLog.warn(`⚠️ Skipped corrupted file (Invalid FourCC): ${fullPath}`);
            } else {
              ipcLog.warn(`⚠️ Failed to parse file: ${fullPath}`, err);
            }
            return null;
          }
        }),
      );
      const metadataResults = await Promise.all(metadataPromises);
      // 过滤掉解析失败的文件，并按创建时间降序排序（最新的在前）
      return metadataResults
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .sort((a, b) => b.createTime - a.createTime);
    } catch (error) {
      ipcLog.error("❌ Error fetching music metadata:", error);
      return [];
    }
  }

  /**
   * 获取指定音乐文件的歌词信息
   * @param musicPath 音乐文件路径
   * @returns 歌词信息对象，包括内置歌词和外部歌词
   */
  async getLyric(musicPath: string): Promise<{
    lyric: string;
    format: "lrc" | "ttml" | "yrc";
    external?: { lyric: string; format: "lrc" | "ttml" | "yrc" };
    embedded?: { lyric: string; format: "lrc" };
  }> {
    try {
      // 获取文件基本信息
      const absPath = resolve(musicPath);
      const dir = dirname(absPath);
      const ext = extname(absPath);
      const baseName = basename(absPath, ext);
      // 读取目录下所有文件
      let files: string[] = [];
      try {
        files = await readdir(dir);
      } catch (error) {
        ipcLog.error("❌ Failed to read directory:", dir);
        throw error;
      }
      // 外部歌词
      let external: { lyric: string; format: "lrc" | "ttml" | "yrc" } | undefined;
      // 内置歌词
      let embedded: { lyric: string; format: "lrc" } | undefined;
      // 查找外部歌词文件
      for (const format of ["ttml", "yrc", "lrc"] as const) {
        // 构造期望目标文件名
        const targetNameLower = `${baseName}.${format}`.toLowerCase();
        // 在文件列表中查找是否存在匹配项（忽略大小写）
        const matchedFileName = files.find((file) => file.toLowerCase() === targetNameLower);
        if (matchedFileName) {
          try {
            const lyricPath = join(dir, matchedFileName);
            const lyric = await readFile(lyricPath, "utf-8");
            // 若不为空
            if (lyric && lyric.trim() !== "") {
              ipcLog.info(`✅ Local lyric found (${format}): ${lyricPath}`);
              external = { lyric, format };
              break; // 找到最高优先级的外部歌词后停止
            }
          } catch {
            // 读取失败则尝试下一种格式
          }
        }
      }
      // 读取内置元数据 (ID3 Tags)
      try {
        const { common } = await parseFile(absPath);
        const syncedLyric = common?.lyrics?.[0]?.syncText;
        if (syncedLyric && syncedLyric.length > 0) {
          embedded = {
            lyric: metaDataLyricsArrayToLrc(syncedLyric),
            format: "lrc",
          };
        } else if (common?.lyrics?.[0]?.text) {
          embedded = {
            lyric: common?.lyrics?.[0]?.text,
            format: "lrc",
          };
        }
      } catch (e) {
        ipcLog.warn(`⚠️ Failed to parse metadata for lyrics: ${absPath}`, e);
      }
      // 返回结果
      const main = external || embedded || { lyric: "", format: "lrc" as const };
      return {
        ...main,
        external,
        embedded,
      };
    } catch (error) {
      ipcLog.error("❌ Error fetching music lyric:", error);
      throw error;
    }
  }

  /**
   * 读取本地目录中的歌词（通过ID查找）
   * @param lyricDirs 歌词目录列表
   * @param id 歌曲ID
   * @returns 歌词内容
   */
  async readLocalLyric(lyricDirs: string[], id: number): Promise<{ lrc: string; ttml: string }> {
    const result = { lrc: "", ttml: "" };

    try {
      // 定义需要查找的模式
      const patterns = {
        ttml: `**/{,*.}${id}.ttml`,
        lrc: `**/{,*.}${id}.lrc`,
      };

      // 遍历每一个目录
      for (const dir of lyricDirs) {
        try {
          // 查找 ttml
          if (!result.ttml) {
            const ttmlFiles = await FastGlob(patterns.ttml, globOpt(dir));
            if (ttmlFiles.length > 0) {
              const filePath = join(dir, ttmlFiles[0]);
              await access(filePath);
              result.ttml = await readFile(filePath, "utf-8");
            }
          }

          // 查找 lrc
          if (!result.lrc) {
            const lrcFiles = await FastGlob(patterns.lrc, globOpt(dir));
            if (lrcFiles.length > 0) {
              const filePath = join(dir, lrcFiles[0]);
              await access(filePath);
              result.lrc = await readFile(filePath, "utf-8");
            }
          }

          // 如果两种文件都找到了就提前结束搜索
          if (result.ttml && result.lrc) break;
        } catch {
          // 某个路径异常，跳过
        }
      }
    } catch {
      /* 忽略错误 */
    }
    return result;
  }

  /**
 * 获取音乐文件的所有元数据
 * @param path 文件路径
 */
async getMetadata(path: string): Promise<{
  fileName: string;
  fileSize: number;
  common: any;
  lyric: string;
  format: any;
  md5: string;
  replayGain: {
    trackGain: number | undefined;
    trackPeak: number | undefined;
    albumGain: number | undefined;
    albumPeak: number | undefined;
  };
}> {
    try {
      const filePath = resolve(path).replace(/\\/g, "/");
      const { common, format } = await parseFile(filePath);
      
      // 检查并修复乱码问题
      const fileName = basename(filePath);
      const baseName = fileName.replace(/\.[^.]+$/, "");
      const ext = extname(filePath).toLowerCase();
      const dirPath = dirname(filePath);
      
      // 检查标题是否为乱码
      let title = common.title;
      if (title && this.isGarbledText(title)) {
        ipcLog.warn(`⚠️ Detected garbled title: ${title}, using file name instead`);
        title = baseName;
      }
      
      // 检查专辑是否为乱码
      let album = common.album;
      if (album && this.isGarbledText(album)) {
        ipcLog.warn(`⚠️ Detected garbled album: ${album}, using file name instead`);
        album = baseName;
      }
      
      // 检查艺术家是否为乱码
      let artists = common.artists;
      if (artists && artists.length > 0 && this.isGarbledText(artists[0])) {
        ipcLog.warn(`⚠️ Detected garbled artist: ${artists[0]}, using '未知艺术家' instead`);
        artists = ["未知艺术家"];
      }
      
      // 检查专辑艺术家是否为乱码
      let albumArtist = common.albumartist;
      if (albumArtist && this.isGarbledText(albumArtist)) {
        ipcLog.warn(`⚠️ Detected garbled album artist: ${albumArtist}, using '未知艺术家' instead`);
        albumArtist = "未知艺术家";
      }
      
      // 创建修复后的 common 对象
      const fixedCommon = {
        ...common,
        title,
        album,
        artists,
        albumArtist,
      };
      
      // 尝试从 WAV 文件的 LYR 标签中读取歌词
      let wavLyric = "";
      if (ext === ".wav" && common?.['LYR']) {
        wavLyric = common['LYR'];
      }
      
      // 从音频文件元数据中获取歌词
      let lyric = 
        metaDataLyricsArrayToLrc(fixedCommon?.lyrics?.[0]?.syncText || []) ||
        fixedCommon?.lyrics?.[0]?.text ||
        wavLyric ||
        "";
      
      // 如果歌词为空，尝试读取本地歌词文件
      if (!lyric) {
        const localLyric = await this.readLocalLyricFile(dirPath, baseName);
        if (localLyric) {
          lyric = localLyric;
          ipcLog.info(`📝 Read lyric from local file: ${baseName}.lrc`);
        }
      }
      
      return {
        // 文件名称
        fileName,
        // 文件大小
        fileSize: (await stat(filePath)).size / (1024 * 1024),
        // 元信息
        common: fixedCommon,
        // 歌词
        lyric,
        // 音质信息
        format,
        // md5
        md5: await getFileMD5(filePath),
        replayGain: {
          trackGain: fixedCommon.replaygain_track_gain?.ratio,
          trackPeak: fixedCommon.replaygain_track_peak?.ratio,
          albumGain: fixedCommon.replaygain_album_gain?.ratio,
          albumPeak: fixedCommon.replaygain_album_peak?.ratio,
        },
      };
    } catch (error) {
      // 对于不支持的音频格式（如 DTS、DSD、APE 等），返回基本元数据
      if (error instanceof Error && error.message.includes("Failed to determine audio format")) {
        const filePath = resolve(path).replace(/\\/g, "/");
        const fileName = basename(filePath);
        const baseName = fileName.replace(/\.[^.]+$/, "");
        const fileSize = (await stat(filePath)).size / (1024 * 1024);
        const md5 = await getFileMD5(filePath);
        const dirPath = dirname(filePath);
        
        ipcLog.warn(`⚠️ Unsupported audio format for metadata: ${path}, returning basic info`);
        
        // 尝试读取本地歌词文件
        let lyric = "";
        const localLyric = await this.readLocalLyricFile(dirPath, baseName);
        if (localLyric) {
          lyric = localLyric;
          ipcLog.info(`📝 Read lyric from local file: ${baseName}.lrc`);
        }
        
        return {
          fileName,
          fileSize,
          common: {
            title: baseName,
            artists: ["未知艺术家"],
            album: "未知专辑",
            track: { no: 0 },
          },
          lyric,
          format: { container: extname(filePath).replace(".", "").toLowerCase() },
          md5,
          replayGain: {
            trackGain: undefined,
            trackPeak: undefined,
            albumGain: undefined,
            albumPeak: undefined,
          },
        };
      }
      
      ipcLog.error("❌ Error fetching music metadata:", error);
      throw error;
    }
  }
  
  /**
   * 检测文本是否为乱码
   * @param text 要检测的文本
   * @returns 是否为乱码
   */
  private isGarbledText(text: string): boolean {
    if (!text) return false;
    
    // 检查是否包含明显的乱码特征
    // 1. 检查是否包含大量的非中文字符和非英文字符
    const chineseCharCount = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const englishCharCount = (text.match(/[a-zA-Z]/g) || []).length;
    const totalCharCount = text.length;
    
    // 如果中文字符和英文字符的总数少于总字符数的一半，可能是乱码
    if (chineseCharCount + englishCharCount < totalCharCount / 2) {
      return true;
    }
    
    // 2. 检查是否包含明显的乱码模式
    const garbledPatterns = [
      /[\x00-\x1f\x7f]/g, // 控制字符
      /[\x80-\xff]{2,}/g, // 连续的扩展 ASCII 字符
      /d[0-9a-f]g[0-9a-f]g[0-9a-f]/i, // 类似 "d8g0g0d80d00" 的模式
    ];
    
    for (const pattern of garbledPatterns) {
      if (pattern.test(text)) {
        return true;
      }
    }
    
    return false;
  }
  
  /**
   * 读取本地歌词文件
   * @param dirPath 目录路径
   * @param baseName 文件名（不含扩展名）
   * @returns 歌词内容
   */
  private async readLocalLyricFile(dirPath: string, baseName: string): Promise<string> {
    try {
      // 支持的歌词文件扩展名
      const lyricExtensions = [".lrc", ".txt"];
      
      // 尝试读取每个扩展名的歌词文件
      for (const ext of lyricExtensions) {
        const lyricPath = join(dirPath, `${baseName}${ext}`);
        
        try {
          // 检查文件是否存在
          await access(lyricPath);
          // 读取文件内容
          const content = await readFile(lyricPath, "utf-8");
          if (content.trim()) {
            return content;
          }
        } catch {
          // 文件不存在或读取失败，继续尝试下一个扩展名
          continue;
        }
      }
      
      // 没有找到有效的歌词文件
      return "";
    } catch (error) {
      ipcLog.error("❌ Error reading local lyric file:", error);
      return "";
    }
  }

  /**
   * 修改音乐元数据
   * @param path 文件路径
   * @param metadata 元数据对象
   */
  async setMetadata(path: string, metadata: MusicMetadataInput) {
    try {
      // 所有格式都使用 FFmpeg
      if (await this.setMetadataWithFFmpeg(path, metadata)) {
        ipcLog.info(`✅ 使用 FFmpeg 成功修改元数据: ${path}`);
        return true;
      }
      
      // 如果失败，抛出错误
      throw new Error("修改元数据失败");
    } catch (error) {
      ipcLog.error("❌ Error setting music metadata:", error);
      throw error;
    }
  }

  /**
   * 使用 FFmpeg 写入元数据
   * @param path 文件路径
   * @param metadata 元数据对象
   */
  private async setMetadataWithFFmpeg(path: string, metadata: MusicMetadataInput): Promise<boolean> {
    try {
      const {
        name,
        artist,
        album,
        alia,
        lyric,
        cover,
        albumArtist,
        genre,
        year,
        trackNumber,
        discNumber,
      } = metadata;
      // 规范化路径
      const songPath = resolve(path);
      const coverPath = cover ? resolve(cover) : undefined;
      const ext = extname(songPath).toLowerCase();

      // 使用 FFmpeg 写入元数据
      const { spawn } = await import("node:child_process");
      const ffmpegArgs = [
        "-i",
        songPath,
      ];

      // 添加封面（如果有）
      if (coverPath) {
        ffmpegArgs.push("-i", coverPath);
      }

      // 映射音频流和封面流
      ffmpegArgs.push("-map", "0:0");
      if (coverPath) {
        ffmpegArgs.push("-map", "1:0");
      }

      // 复制音频流，不重新编码
      ffmpegArgs.push("-c:a", "copy");

      // 对于封面，复制视频流
      if (coverPath) {
        ffmpegArgs.push("-c:v", "copy");
      }

      // 清除所有现有元数据，然后写入新的
      // 使用 -map_metadata -1 清除所有现有元数据
      ffmpegArgs.push("-map_metadata", "-1");

      // 添加元数据（使用标准标签）
      if (name) ffmpegArgs.push("-metadata", `title=${name}`);
      if (artist) ffmpegArgs.push("-metadata", `artist=${artist}`);
      if (album) ffmpegArgs.push("-metadata", `album=${album}`);
      if (albumArtist) ffmpegArgs.push("-metadata", `album_artist=${albumArtist}`);
      if (genre) ffmpegArgs.push("-metadata", `genre=${genre}`);
      if (year) ffmpegArgs.push("-metadata", `date=${year}`);
      if (trackNumber) ffmpegArgs.push("-metadata", `track=${trackNumber}`);
      if (discNumber) ffmpegArgs.push("-metadata", `disc=${discNumber}`);
      if (alia) ffmpegArgs.push("-metadata", `comment=${alia}`);
      if (lyric) {
        // 对于 WAV 文件，使用 LYR 标签
        if (ext === ".wav") {
          ffmpegArgs.push("-metadata", `LYR=${lyric}`);
        } else {
          ffmpegArgs.push("-metadata", `lyrics=${lyric}`);
        }
      }

      // 对于 MP3 文件，设置 ID3v2 版本
      if (ext === ".mp3") {
        ffmpegArgs.push("-id3v2_version", "3", "-write_id3v1", "1");
      }

      // 输出文件（临时文件）
      const tempPath = songPath.replace(new RegExp(`${ext}$`), `.temp${ext}`);
      ffmpegArgs.push("-y", tempPath);

      // 查找 FFmpeg
      const ffmpegPath = await this.findFFmpeg();
      if (!ffmpegPath) {
        throw new Error("FFmpeg not found. Please install FFmpeg or configure the path in settings.");
      }

      ipcLog.info(`[FFmpeg] 执行命令: ${ffmpegPath} ${ffmpegArgs.join(" ")}`);

      // 执行 FFmpeg 命令
      await new Promise<void>((resolve, reject) => {
        // 在 Windows 上使用 shell: true 来确保命令正确执行
        const options = process.platform === "win32" ? { shell: true } : {};
        const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, options);
        let stderr = "";
        let stdout = "";

        ffmpegProcess.stdout.on("data", (data) => {
          stdout += data.toString();
        });

        ffmpegProcess.stderr.on("data", (data) => {
          stderr += data.toString();
        });

        ffmpegProcess.on("close", (code) => {
          ipcLog.info(`[FFmpeg] 退出码: ${code}`);
          if (stdout) ipcLog.info(`[FFmpeg] 输出: ${stdout}`);
          if (stderr) ipcLog.info(`[FFmpeg] 错误输出: ${stderr}`);
          
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`FFmpeg failed with code ${code}: ${stderr}`));
          }
        });

        ffmpegProcess.on("error", (error) => {
          ipcLog.error(`[FFmpeg] 进程错误:`, error);
          reject(error);
        });
      });

      // 替换原文件（使用更安全的方法）
      const { rename, unlink, stat } = await import("node:fs/promises");
      
      // 确保临时文件存在
      try {
        const tempStat = await stat(tempPath);
        ipcLog.info(`[FFmpeg] 临时文件创建成功: ${tempPath}, 大小: ${tempStat.size} bytes`);
      } catch (error) {
        ipcLog.error(`[FFmpeg] 临时文件不存在: ${tempPath}`, error);
        throw new Error(`Temporary file not created: ${tempPath}`);
      }
      
      // 备份原文件
      const backupPath = songPath + ".bak";
      try {
        await rename(songPath, backupPath);
        ipcLog.info(`[FFmpeg] 原文件已备份: ${backupPath}`);
      } catch (error) {
        ipcLog.error(`[FFmpeg] 备份原文件失败:`, error);
        throw new Error(`Failed to backup original file: ${error}`);
      }
      
      // 重命名临时文件为原文件
      try {
        await rename(tempPath, songPath);
        ipcLog.info(`[FFmpeg] 临时文件已重命名为原文件: ${songPath}`);
      } catch (error) {
        // 如果重命名失败，恢复备份
        try {
          await rename(backupPath, songPath);
          ipcLog.info(`[FFmpeg] 已恢复备份文件: ${backupPath}`);
        } catch (recoverError) {
          ipcLog.error("❌ Failed to recover backup:", recoverError);
        }
        throw new Error(`Failed to rename temporary file: ${error}`);
      }
      
      // 删除备份文件
      try {
        await unlink(backupPath);
        ipcLog.info(`[FFmpeg] 备份文件已删除: ${backupPath}`);
      } catch (error) {
        ipcLog.warn("⚠️ Failed to delete backup file:", error);
      }

      return true;
    } catch (error) {
      ipcLog.error("❌ Error setting music metadata with FFmpeg:", error);
      return false;
    }
  }

  /**
   * 查找 FFmpeg 可执行文件
   */
  private async findFFmpeg(): Promise<string | null> {
    const { access } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { useStore } = await import("../store");
    const store = useStore();
    const customFFmpegPath = store.get("ffmpegPath") as string | undefined;

    if (customFFmpegPath && customFFmpegPath.trim()) {
      try {
        await access(customFFmpegPath);
        return customFFmpegPath;
      } catch {
        ipcLog.warn(`Custom FFmpeg path not found: ${customFFmpegPath}`);
      }
    }

    // 检查系统 PATH 中的 ffmpeg
    const systemPaths = process.platform === "win32"
      ? ["ffmpeg.exe", "ffmpeg"]
      : ["ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"];

    for (const cmd of systemPaths) {
      try {
        const result = await this.testFFmpegCommand(cmd);
        if (result) {
          return cmd;
        }
      } catch {
        continue;
      }
    }

    // 检查常见的安装位置
    const commonPaths = process.platform === "win32"
      ? [
          join(process.env.PROGRAMFILES || "C:\\Program Files", "ffmpeg", "bin", "ffmpeg.exe"),
          join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "ffmpeg", "bin", "ffmpeg.exe"),
          join(process.env.LOCALAPPDATA || process.env.USERPROFILE || "", "ffmpeg", "bin", "ffmpeg.exe"),
        ]
      : ["/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"];

    for (const path of commonPaths) {
      try {
        await access(path);
        const result = await this.testFFmpegCommand(path);
        if (result) {
          return path;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  /**
   * 测试 FFmpeg 命令是否可用
   */
  private async testFFmpegCommand(ffmpegPath: string): Promise<boolean> {
    const { spawn } = await import("node:child_process");
    return new Promise((resolve) => {
      const process = spawn(ffmpegPath, ["-version"]);
      process.on("close", (code) => {
        resolve(code === 0);
      });
      process.on("error", () => {
        resolve(false);
      });
    });
  }

  /**
   * 获取音乐封面
   * @param path 文件路径
   */
  async getCover(path: string): Promise<{ data: Buffer; format: string } | null> {
    try {
      const { common } = await parseFile(path);
      // 获取封面数据
      const picture = common.picture?.[0];
      if (picture) {
        return { data: Buffer.from(picture.data), format: picture.format };
      } else {
        const coverFilePath = path.replace(/\.[^.]+$/, ".jpg");
        try {
          await access(coverFilePath);
          const coverData = await readFile(coverFilePath);
          return { data: coverData, format: "image/jpeg" };
        } catch {
          return null;
        }
      }
    } catch (error) {
      // 对于不支持的音频格式（如 DTS、DSD、APE 等），尝试查找封面文件
      if (error instanceof Error && error.message.includes("Failed to determine audio format")) {
        const coverFilePath = path.replace(/\.[^.]+$/, ".jpg");
        try {
          await access(coverFilePath);
          const coverData = await readFile(coverFilePath);
          console.log(`✅ Found cover file for unsupported format: ${coverFilePath}`);
          return { data: coverData, format: "image/jpeg" };
        } catch {
          console.log(`ℹ️ No cover file found for: ${path}`);
          return null;
        }
      }
      console.error("❌ Error fetching music cover:", error);
      throw error;
    }
  }
}
