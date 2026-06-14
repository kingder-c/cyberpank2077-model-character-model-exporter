import { existsSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { spawn } from "node:child_process";
import { getSaveModelCacheDir } from "../../../modelStore";

export default defineEventHandler(async (event) => {
  const saveId = getRouterParam(event, "saveId");
  if (!saveId) {
    throw createError({ statusCode: 400, statusMessage: "缺少存档 ID" });
  }

  const cacheDir = getSaveModelCacheDir(saveId);
  if (!existsSync(cacheDir)) {
    await fsp.mkdir(cacheDir, { recursive: true });
  }

  if (process.platform === "win32") {
    spawn("explorer.exe", [cacheDir], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  }

  return {
    cacheDir,
    opened: process.platform === "win32",
  };
});
