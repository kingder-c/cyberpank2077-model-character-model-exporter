import { promises as fsp } from "node:fs";
import { getArtifactFile } from "../../../modelStore";

export default defineEventHandler(async (event) => {
  const saveId = getRouterParam(event, "saveId");
  if (!saveId) {
    throw createError({ statusCode: 400, statusMessage: "缺少存档 ID" });
  }

  const filePath = getArtifactFile(saveId, "3mf");
  if (!filePath) {
    throw createError({ statusCode: 404, statusMessage: "还没有生成 3MF 打印模型，请先点击生成/刷新模型。" });
  }

  setHeader(event, "Content-Type", "model/3mf");
  setHeader(event, "Content-Disposition", `attachment; filename="cyberpunk-v-${saveId}.3mf"`);
  setHeader(event, "Cache-Control", "no-store");
  return new Uint8Array(await fsp.readFile(filePath));
});
