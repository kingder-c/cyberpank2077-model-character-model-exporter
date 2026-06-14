import { existsSync, promises as fsp } from "node:fs";
import { getSaveScreenshotPath } from "../../../saveStore";

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id");
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: "缺少存档 ID" });
  }

  const screenshotPath = await getSaveScreenshotPath(id);
  if (!screenshotPath || !existsSync(screenshotPath)) {
    throw createError({ statusCode: 404, statusMessage: "该存档没有截图" });
  }

  setHeader(event, "Content-Type", "image/png");
  setHeader(event, "Cache-Control", "no-store");
  return new Uint8Array(await fsp.readFile(screenshotPath));
});
