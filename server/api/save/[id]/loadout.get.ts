import { getSaveLoadout } from "../../../saveStore";

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id");
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: "缺少存档 ID" });
  }

  const loadout = await getSaveLoadout(id);
  if (!loadout) {
    throw createError({ statusCode: 404, statusMessage: "未找到该存档，请重新扫描" });
  }

  return loadout;
});
