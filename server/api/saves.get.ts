import { getDefaultSaveDir, scanSaves } from "../saveStore";

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const saveDir = typeof query.saveDir === "string" && query.saveDir.trim() ? query.saveDir.trim() : getDefaultSaveDir();
  const saves = await scanSaves(saveDir);

  return {
    defaultSaveDir: getDefaultSaveDir(),
    saveDir,
    saves,
  };
});
