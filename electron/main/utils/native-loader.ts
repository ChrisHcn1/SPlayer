import { app } from "electron";
import { createRequire } from "module";
import path from "path";
import { processLog } from "../logger";

const requireNative = createRequire(import.meta.url);

/**
 * 注入 FFmpeg DLL 搜索路径
 * 必须在加载 ffmpeg-decoder.node 之前调用，否则找不到依赖的动态库
 * 注意：该函数已不再使用，因为 ffmpeg-decoder 模块已被移除，使用外部 ffplay 代替
 */
// function injectFfmpegDllPath() {
//   let ffmpegDllDir = "";

//   if (app.isPackaged) {
//     // 打包环境：DLL 在 resources/ffmpeg/ 目录
//     ffmpegDllDir = path.join(process.resourcesPath, "ffmpeg");
//   } else {
//     // 开发环境：从 VCPKG_ROOT 或 FFMPEG_DIR 获取
//     const vcpkgRoot = process.env.VCPKG_ROOT;
//     const ffmpegDir = process.env.FFMPEG_DIR;

//     if (vcpkgRoot) {
//       ffmpegDllDir = path.join(vcpkgRoot, "installed", "x64-windows", "bin");
//     } else if (ffmpegDir) {
//       ffmpegDllDir = path.join(ffmpegDir, "bin");
//     }
//   }

//   if (ffmpegDllDir && !process.env.PATH?.includes(ffmpegDllDir)) {
//     process.env.PATH = `${ffmpegDllDir};${process.env.PATH}`;
//     processLog.info(`[NativeLoader] 注入 FFmpeg DLL 路径: ${ffmpegDllDir}`);
//   }
// }

/**
 * 加载一个原生插件
 * @param fileName 编译后的文件名 (例如: "external-media-integration.node")
 * @param devDirName 开发环境下的目录名 (例如: "external-media-integration")，必须位于项目根目录的 native/ 下
 */
export function loadNativeModule(fileName: string, devDirName: string) {
  let nativeModulePath: string;

  // ffmpeg-decoder 模块已移除，使用外部 ffplay 代替
  // if (fileName.includes("ffmpeg-decoder")) {
  //   injectFfmpegDllPath();
  // }

  if (app.isPackaged) {
    nativeModulePath = path.join(process.resourcesPath, "native", fileName);
  } else {
    // 适配 tools 模块的路径结构 (native/tools/tools.node)
    // 其他模块可能是 (native/xxx/xxx.node) 或者 (native/xxx/index.node)
    // 这里简单约定 devDirName 就是 native 下的一级目录名
    nativeModulePath = path.join(process.cwd(), "native", devDirName, fileName);
  }

  try {
    processLog.info(`[NativeLoader] 尝试加载原生模块: ${nativeModulePath}`);
    const module = requireNative(nativeModulePath);
    processLog.info(`[NativeLoader] 成功加载 ${fileName}`);
    return module;
  } catch (error) {
    processLog.error(`[NativeLoader] 加载 ${fileName} 失败:`, error);

    // 尝试加载备用文件名 (例如: ffmpeg-decoder.win32-x64-msvc.node)
    if (!app.isPackaged && fileName.includes(".node")) {
      const baseName = fileName.replace(".node", "");
      const altFileName = `${baseName}.win32-x64-msvc.node`;
      const altPath = path.join(process.cwd(), "native", devDirName, altFileName);
      try {
        processLog.info(`[NativeLoader] 尝试加载备用模块: ${altPath}`);
        const module = requireNative(altPath);
        processLog.info(`[NativeLoader] 成功加载备用模块 ${altFileName}`);
        return module;
      } catch (altError) {
        processLog.error(`[NativeLoader] 加载备用模块 ${altFileName} 也失败:`, altError);
      }
    }

    return null;
  }
}
