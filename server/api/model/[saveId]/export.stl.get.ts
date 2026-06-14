import { promises as fsp } from "node:fs";
import { getArtifactFile } from "../../../modelStore";

export default defineEventHandler(async (event) => {
  const saveId = getRouterParam(event, "saveId");
  if (!saveId) {
    throw createError({ statusCode: 400, statusMessage: "缺少存档 ID" });
  }

  const filePath = getArtifactFile(saveId, "stl");
  if (!filePath) {
    throw createError({ statusCode: 404, statusMessage: "还没有生成 STL 打印模型，请先点击生成/刷新模型。" });
  }

  setHeader(event, "Content-Type", "model/stl");
  setHeader(event, "Content-Disposition", `attachment; filename="cyberpunk-v-${saveId}.stl"`);
  setHeader(event, "Cache-Control", "no-store");
  return new Uint8Array(await fsp.readFile(filePath));
});
