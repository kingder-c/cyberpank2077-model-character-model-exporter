import { scanAndRegister } from "../modelStore";

type ScanRequest = {
  gameDir?: string;
  query?: string;
};

export default defineEventHandler(async (event) => {
  const body = (await readBody(event)) as ScanRequest;
  const gameDir = body?.gameDir || "D:\\Program Files (x86)\\Steam\\steamapps\\common\\Cyberpunk 2077";
  const query = body?.query || "";

  const items = await scanAndRegister(gameDir, query);
  if (!items.length) {
    return {
      items: [],
      message:
        "没有找到可直接预览的模型文件。主流程会通过存档选择和模型构建任务生成 GLB/STL。",
    };
  }

  return {
    items,
    message: `扫描完成，找到 ${items.length} 个模型文件。`,
  };
});
