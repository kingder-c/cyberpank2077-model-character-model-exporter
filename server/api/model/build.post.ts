import { startModelBuild, type RenderOptions } from "../../modelStore";

type BuildBody = {
  saveId?: string;
  gameDir?: string;
  force?: boolean;
  renderOptions?: Partial<RenderOptions>;
};

export default defineEventHandler(async (event) => {
  const body = (await readBody(event)) as BuildBody;
  if (!body?.saveId) {
    throw createError({ statusCode: 400, statusMessage: "缺少 saveId" });
  }

  const job = startModelBuild({
    saveId: body.saveId,
    gameDir: body.gameDir,
    force: Boolean(body.force),
    renderOptions: body.renderOptions,
  });

  return {
    jobId: job.id,
    job,
  };
});
