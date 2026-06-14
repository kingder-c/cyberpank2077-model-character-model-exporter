import { detectTools, getDefaultGameDir, SUPPORTED_EXTS } from "../modelStore";
import { getDefaultSaveDir } from "../saveStore";

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const gameDir = typeof query.gameDir === "string" && query.gameDir.trim() ? query.gameDir.trim() : getDefaultGameDir();

  return {
    defaultGameDir: getDefaultGameDir(),
    defaultSaveDir: getDefaultSaveDir(),
    supported: [...SUPPORTED_EXTS],
    tools: detectTools(gameDir),
  };
});
