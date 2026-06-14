import { existsSync, promises as fsp, statSync } from "node:fs";
import path from "node:path";
import { getModelPath } from "../../modelStore";

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id");
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: "Invalid model ID" });
  }

  const filePath = getModelPath(id);
  if (!filePath) {
    throw createError({
      statusCode: 404,
      statusMessage: "Model not found. Please scan again and make sure the file still exists.",
    });
  }

  if (!existsSync(filePath)) {
    throw createError({ statusCode: 404, statusMessage: "File does not exist." });
  }

  const ext = path.extname(filePath).toLowerCase();
  const stats = statSync(filePath);
  if (!stats.isFile()) {
    throw createError({ statusCode: 400, statusMessage: "Requested path is not a file." });
  }

  const mime =
    ext === ".gltf" || ext === ".glb"
      ? "model/gltf+json"
      : ext === ".obj"
      ? "model/obj"
      : ext === ".stl"
      ? "model/stl"
      : ext === ".ply"
      ? "model/ply"
      : "application/octet-stream";

  setHeader(event, "Content-Type", mime);
  setHeader(event, "Cache-Control", "no-store");
  return new Uint8Array(await fsp.readFile(filePath));
});
