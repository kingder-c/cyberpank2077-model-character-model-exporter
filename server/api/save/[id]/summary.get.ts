import { getArtifacts } from "../../../modelStore";
import { analyzeSave } from "../../../saveStore";

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id");
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: "缺少存档 ID" });
  }

  const analysis = await analyzeSave(id);
  if (!analysis) {
    throw createError({ statusCode: 404, statusMessage: "未找到该存档，请重新扫描" });
  }

  const artifacts = getArtifacts(id);
  return {
    saveId: id,
    saveName: analysis.save.name,
    modifiedAt: analysis.save.modifiedAt,
    buildPatch: analysis.appearance.buildPatch,
    gameVersion: analysis.appearance.gameVersion,
    bodyGender: analysis.appearance.bodyGender,
    brainGender: analysis.appearance.brainGender,
    bodyVariant: analysis.appearance.bodyVariant,
    appearanceNodeFound: analysis.appearanceNodes.length > 0,
    artifacts,
  };
});
