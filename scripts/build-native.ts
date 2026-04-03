import dotenv from "dotenv";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

interface NativeModule {
  name: string;
  enabled?: boolean;
}

const isRustAvailable = () => {
  try {
    execSync("cargo --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const platform = os.platform();
const isWindows = platform === "win32";

dotenv.config({ path: path.resolve(import.meta.dirname, "../.env") });

if (process.env.SKIP_NATIVE_BUILD === "true") {
  console.log("[BuildNative] SKIP_NATIVE_BUILD 已设置，跳过原生模块构建");
  process.exit(0);
}

if (!isRustAvailable()) {
  console.error("[BuildNative] 错误：检测不到 Rust 工具链");
  console.error("[BuildNative] 未设置 SKIP_NATIVE_BUILD，因此必须包含 Rust 环境才能继续");
  console.error(
    "[BuildNative] 安装 Rust (https://rust-lang.org/tools/install/) 或者设置环境变量 SKIP_NATIVE_BUILD=true",
  );
  process.exit(1);
}

const modules: NativeModule[] = [
  {
    name: "external-media-integration",
  },
  {
    name: "tools",
  },
  {
    name: "taskbar-lyric",
    enabled: isWindows,
  },
  // ffmpeg-decoder 模块已移除，使用外部 ffplay 代替
  // {
  //   name: "ffmpeg-decoder",
  // },
  // 有人抱怨编译 wasm 总是有问题，暂时注释掉
  // {
  //   name: "ferrous-opencc-wasm",
  // },
];

/**
 * 复制 FFmpeg 动态库到 resources/ffmpeg 目录
 * 用于打包时将 DLL 作为外部资源包含
 */
function copyFfmpegDlls() {
  if (!isWindows) {
    console.log("[BuildNative] 非 Windows 平台，跳过 FFmpeg DLL 复制");
    return;
  }

  // 查找 FFmpeg DLL 来源目录
  const vcpkgRoot = process.env.VCPKG_ROOT;
  const ffmpegDir = process.env.FFMPEG_DIR || "E:\\ffmpeg-8.0.1-full_build-shared";

  let ffmpegBinDir = "";
  if (ffmpegDir) {
    ffmpegBinDir = path.join(ffmpegDir, "bin");
  } else if (vcpkgRoot) {
    ffmpegBinDir = path.join(vcpkgRoot, "installed", "x64-windows", "bin");
  }

  if (!ffmpegBinDir || !fs.existsSync(ffmpegBinDir)) {
    console.warn(
      "[BuildNative] 未找到 FFmpeg DLL 目录，跳过复制。请设置 VCPKG_ROOT 或 FFMPEG_DIR 环境变量",
    );
    return;
  }

  // 目标目录
  const targetDir = path.resolve(import.meta.dirname, "../resources/ffmpeg");
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // 需要复制的 DLL 匹配模式
  const dllPatterns = ["avcodec-*.dll", "avformat-*.dll", "avutil-*.dll", "swresample-*.dll"];

  let copiedCount = 0;

  // 读取目录中的所有文件
  const files = fs.readdirSync(ffmpegBinDir);

  // 复制 FFmpeg 核心 DLL
  for (const pattern of dllPatterns) {
    // 将通配符模式转换为正则表达式
    const regexPattern = pattern.replace(/\*/g, ".*");
    const regex = new RegExp(`^${regexPattern}$`);

    for (const fileName of files) {
      if (regex.test(fileName)) {
        const srcPath = path.join(ffmpegBinDir, fileName);
        const destPath = path.join(targetDir, fileName);
        fs.copyFileSync(srcPath, destPath);
        console.log(`[BuildNative] 复制 FFmpeg DLL: ${fileName}`);
        copiedCount++;
      }
    }
  }

  // 复制 FFmpeg 依赖的其他 DLL（如 zlib 等）
  const depPatterns = ["zlib*.dll", "bz2*.dll", "lzma*.dll"];
  for (const pattern of depPatterns) {
    const regexPattern = pattern.replace(/\*/g, ".*");
    const regex = new RegExp(`^${regexPattern}$`);

    for (const fileName of files) {
      if (regex.test(fileName)) {
        const srcPath = path.join(ffmpegBinDir, fileName);
        const destPath = path.join(targetDir, fileName);
        fs.copyFileSync(srcPath, destPath);
        console.log(`[BuildNative] 复制 FFmpeg 依赖 DLL: ${fileName}`);
        copiedCount++;
      }
    }
  }

  if (copiedCount > 0) {
    console.log(`[BuildNative] FFmpeg DLL 复制完成，共 ${copiedCount} 个文件 -> ${targetDir}`);
  } else {
    console.warn(`[BuildNative] 在 ${ffmpegBinDir} 中未找到 FFmpeg DLL 文件`);
  }
}

try {
  const args = process.argv.slice(2);
  const isDev = args.includes("--dev");
  const buildCommand = isDev ? "build:debug" : "build";

  for (const mod of modules) {
    if (mod.enabled === false) {
      continue;
    }
    execSync(`pnpm --filter ${mod.name} ${buildCommand}`, {
      stdio: "inherit",
    });
  }

  // 构建完成后复制 FFmpeg DLL
  copyFfmpegDlls();
} catch (error) {
  console.error("[BuildNative] 模块构建失败", error);
  process.exit(1);
}
