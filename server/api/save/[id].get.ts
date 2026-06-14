import { analyzeSave } from "../../saveStore";

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id");
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: "缺少存档 ID" });
  }

  const analysis = await analyzeSave(id);
  if (!analysis) {
    throw createError({ statusCode: 404, statusMessage: "未找到该存档，请重新扫描" });
  }

  return analysis;
});
