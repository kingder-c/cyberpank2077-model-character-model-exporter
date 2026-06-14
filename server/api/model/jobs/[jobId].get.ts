import { getJob } from "../../../modelStore";

export default defineEventHandler(async (event) => {
  const jobId = getRouterParam(event, "jobId");
  if (!jobId) {
    throw createError({ statusCode: 400, statusMessage: "缺少任务 ID" });
  }

  const job = getJob(jobId);
  if (!job) {
    throw createError({ statusCode: 404, statusMessage: "未找到模型生成任务" });
  }

  return job;
});
