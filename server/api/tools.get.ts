import { detectTools, getDefaultGameDir } from "../modelStore";

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const gameDir = typeof query.gameDir === "string" && query.gameDir.trim() ? query.gameDir.trim() : getDefaultGameDir();

  return {
    gameDir,
    tools: detectTools(gameDir),
  };
});
