import { join } from "path";
import { tmpdir } from "os";
import { createWriteStream, existsSync } from "fs";
import { isDev } from "../main/utils/config";
import { serverLog } from "../main/logger";
import { initNcmAPI } from "./netease";
import { initUnblockAPI } from "./unblock";
import { initControlAPI } from "./control";
import { initQQMusicAPI } from "./qqmusic";
import { ffplayAudioService } from "../main/services/FFplayAudioService";
import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fastify from "fastify";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";

// 查找内置的ffmpeg路径
function findFFmpegPath(): string {
  const possiblePaths = [
    // 开发环境路径
    join(process.cwd(), "ffmpeg", "bin", "ffmpeg.exe"),
    join(process.cwd(), "ffmpeg", "ffmpeg.exe"),
    join(__dirname, "..", "..", "ffmpeg", "bin", "ffmpeg.exe"),
    join(__dirname, "..", "..", "ffmpeg", "ffmpeg.exe"),
    // 打包环境路径
    join(process.resourcesPath, "ffmpeg", "bin", "ffmpeg.exe"),
    join(process.resourcesPath, "ffmpeg", "ffmpeg.exe"),
  ];

  for (const p of possiblePaths) {
    if (existsSync(p)) {
      return p;
    }
  }

  // 如果找不到，返回系统ffmpeg
  return "ffmpeg";
}

const ffmpegPath = findFFmpegPath();
serverLog.info(`[Server] Using FFmpeg at: ${ffmpegPath}`);

const initAppServer = async () => {
  try {
    const server = fastify({
      routerOptions: {
        // 忽略尾随斜杠
        ignoreTrailingSlash: true,
      },
    });
    // 注册插件
    server.register(fastifyCookie);
    server.register(fastifyMultipart);
    // 生产环境启用静态文件
    if (!isDev) {
      serverLog.info("📂 Serving static files from /renderer");
      server.register(fastifyStatic, {
        root: join(__dirname, "../renderer"),
      });
    }
    // 声明
    server.get("/api", (_, reply) => {
      reply.send({
        name: "SPlayer API",
        description: "SPlayer API service",
        author: "@imsyy",
        list: [
          {
            name: "NeteaseCloudMusicApi",
            url: "/api/netease",
          },
          {
            name: "UnblockAPI",
            url: "/api/unblock",
          },
          {
            name: "ControlAPI",
            url: "/api/control",
          },
          {
            name: "QQMusicAPI",
            url: "/api/qqmusic",
          },
          {
            name: "FFmpegAPI",
            url: "/api/ffmpeg",
          },
        ],
      });
    });

    // 文件上传接口
    server.post("/api/upload", async (request, reply) => {
      try {
        const data = await request.file();
        if (!data) {
          return reply.code(400).send({ error: "No file uploaded" });
        }

        const tempDir = tmpdir();
        const filePath = join(
          tempDir,
          `temp_audio_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        );
        const writeStream = createWriteStream(filePath);
        data.file.pipe(writeStream);
        await new Promise<void>((resolve, reject) => {
          writeStream.on("finish", resolve);
          writeStream.on("error", reject);
        });

        return reply.send({ url: `file://${filePath}` });
      } catch (error) {
        serverLog.error("Upload error:", error);
        return reply.code(500).send({ error: "Upload failed" });
      }
    });

    // FFmpeg 元数据接口
    server.get("/api/ffmpeg/metadata", async (request, reply) => {
      try {
        const { url } = request.query as { url: string };
        if (!url) {
          return reply.code(400).send({ error: "URL is required" });
        }

        const filePath = url.replace("file://", "");
        const ffmpeg = spawn(ffmpegPath, ["-i", filePath, "-f", "null", "-"]);

        let output = "";

        ffmpeg.stderr.on("data", (data) => {
          output += data.toString();
        });

        return new Promise((resolve) => {
          ffmpeg.on("close", (code) => {
            if (code !== 0) {
              resolve(
                reply
                  .code(500)
                  .send({ error: `FFmpeg metadata extraction failed with code ${code}` }),
              );
              return;
            }

            // 解析元数据
            const durationMatch = output.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
            const sampleRateMatch = output.match(/(\d+) Hz/);
            const channelsMatch = output.match(/(\d+) channels/);

            if (!durationMatch) {
              resolve(reply.code(500).send({ error: "Failed to extract duration" }));
              return;
            }

            const hours = parseInt(durationMatch[1], 10);
            const minutes = parseInt(durationMatch[2], 10);
            const seconds = parseFloat(durationMatch[3]);
            const duration = hours * 3600 + minutes * 60 + seconds;

            const sampleRate = sampleRateMatch ? parseInt(sampleRateMatch[1], 10) : 44100;
            const channels = channelsMatch ? parseInt(channelsMatch[1], 10) : 2;

            resolve(
              reply.send({
                sampleRate,
                channels,
                duration,
              }),
            );
          });

          ffmpeg.on("error", (error) => {
            serverLog.error("FFmpeg error:", error);
            resolve(reply.code(500).send({ error: error.message }));
          });
        });
      } catch (error) {
        serverLog.error("Metadata error:", error);
        return reply.code(500).send({ error: "Failed to get metadata" });
      }
    });

    // FFmpeg 解码接口
    server.get("/api/ffmpeg/decode", async (request, reply) => {
      try {
        const { url } = request.query as { url: string };
        if (!url) {
          return reply.code(400).send({ error: "URL is required" });
        }

        const filePath = url.replace("file://", "");
        const tempDir = tmpdir();
        const outputPath = join(
          tempDir,
          `temp_pcm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.pcm`,
        );

        const ffmpeg = spawn(ffmpegPath, [
          "-i",
          filePath,
          "-f",
          "s16le",
          "-acodec",
          "pcm_s16le",
          "-ar",
          "44100",
          "-ac",
          "2",
          outputPath,
        ]);

        return new Promise((resolve) => {
          ffmpeg.on("close", async (code) => {
            if (code !== 0) {
              resolve(reply.code(500).send({ error: `FFmpeg decoding failed with code ${code}` }));
              return;
            }

            try {
              const pcmData = await fs.readFile(outputPath);
              await fs.unlink(outputPath);
              reply.header("Content-Type", "application/octet-stream");
              resolve(reply.send(pcmData));
            } catch (error) {
              serverLog.error("Read PCM file error:", error);
              resolve(reply.code(500).send({ error: "Failed to read PCM data" }));
            }
          });

          ffmpeg.on("error", (error) => {
            serverLog.error("FFmpeg error:", error);
            resolve(reply.code(500).send({ error: error.message }));
          });
        });
      } catch (error) {
        serverLog.error("Decode error:", error);
        return reply.code(500).send({ error: "Failed to decode audio" });
      }
    });

    // FFplay 元数据接口
    server.get("/api/ffplay/metadata", async (request, reply) => {
      try {
        const { path } = request.query as { path: string };
        if (!path) {
          return reply.code(400).send({ error: "Path is required" });
        }

        // 先进行URL解码，再移除file://前缀
        const decodedPath = decodeURIComponent(path);
        const filePath = decodedPath.replace("file://", "");
        serverLog.info(`[Server] Getting FFplay metadata for: ${filePath}`);
        const metadata = await ffplayAudioService.getMetadata(filePath);
        return reply.send(metadata);
      } catch (error) {
        serverLog.error("FFplay metadata error:", error);
        return reply.code(500).send({ error: (error as Error).message });
      }
    });

    // FFplay 播放接口
    server.get("/api/ffplay/play", async (request, reply) => {
      try {
        const { path, startTime } = request.query as { path: string; startTime: string };
        if (!path) {
          return reply.code(400).send({ error: "Path is required" });
        }

        // 先进行URL解码，再移除file://前缀
        const decodedPath = decodeURIComponent(path);
        const filePath = decodedPath.replace("file://", "");
        serverLog.info(`[Server] Playing with FFplay: ${filePath}`);
        const start = parseFloat(startTime || "0");
        const result = await ffplayAudioService.play(filePath, start);
        return reply.send(result);
      } catch (error) {
        serverLog.error("FFplay play error:", error);
        return reply.code(500).send({ error: (error as Error).message });
      }
    });

    // FFplay 暂停接口
    server.get("/api/ffplay/pause", async (request, reply) => {
      try {
        const { processId } = request.query as { processId: string };
        if (!processId) {
          return reply.code(400).send({ error: "Process ID is required" });
        }

        await ffplayAudioService.pause(parseInt(processId));
        return reply.send({ success: true });
      } catch (error) {
        serverLog.error("FFplay pause error:", error);
        return reply.code(500).send({ error: (error as Error).message });
      }
    });

    // FFplay 停止接口
    server.get("/api/ffplay/stop", async (request, reply) => {
      try {
        const { processId } = request.query as { processId: string };
        if (!processId) {
          return reply.code(400).send({ error: "Process ID is required" });
        }

        await ffplayAudioService.stop(parseInt(processId));
        return reply.send({ success: true });
      } catch (error) {
        serverLog.error("FFplay stop error:", error);
        return reply.code(500).send({ error: (error as Error).message });
      }
    });

    // FFplay 跳转接口
    server.get("/api/ffplay/seek", async (request, reply) => {
      try {
        const { processId, time } = request.query as { processId: string; time: string };
        if (!processId || !time) {
          return reply.code(400).send({ error: "Process ID and time are required" });
        }

        const newProcessId = await ffplayAudioService.seek(parseInt(processId), parseFloat(time));
        return reply.send({ success: true, processId: newProcessId });
      } catch (error) {
        serverLog.error("FFplay seek error:", error);
        return reply.code(500).send({ error: (error as Error).message });
      }
    });

    // FFplay 速率接口
    server.get("/api/ffplay/rate", async (request, reply) => {
      try {
        const { processId, rate } = request.query as { processId: string; rate: string };
        if (!processId || !rate) {
          return reply.code(400).send({ error: "Process ID and rate are required" });
        }

        await ffplayAudioService.setRate(parseInt(processId), parseFloat(rate));
        return reply.send({ success: true });
      } catch (error) {
        serverLog.error("FFplay rate error:", error);
        return reply.code(500).send({ error: (error as Error).message });
      }
    });

    // FFplay 状态接口
    server.get("/api/ffplay/status", async (request, reply) => {
      try {
        const { processId } = request.query as { processId: string };
        if (!processId) {
          return reply.code(400).send({ error: "Process ID is required" });
        }

        const status = ffplayAudioService.getStatus(parseInt(processId));
        return reply.send(status);
      } catch (error) {
        serverLog.error("FFplay status error:", error);
        return reply.code(500).send({ error: (error as Error).message });
      }
    });
    // 注册接口
    server.register(initNcmAPI, { prefix: "/api" });
    server.register(initUnblockAPI, { prefix: "/api" });
    server.register(initControlAPI, { prefix: "/api" });
    server.register(initQQMusicAPI, { prefix: "/api" });
    // 启动端口
    const port = Number(process.env["VITE_SERVER_PORT"] || 25884);
    await server.listen({ port, host: "127.0.0.1" });
    serverLog.info(`🌐 Starting AppServer on port ${port}`);
    return server;
  } catch (error) {
    serverLog.error("🚫 AppServer failed to start");
    throw error;
  }
};

export default initAppServer;
