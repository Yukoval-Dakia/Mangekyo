import { requestId } from "./api";
import { bindDeletionWatermark, synchronizeDeletion, verifyGenerationReceipt } from "./deletion-watermark";

export const materialFetchHelpers = {
  requestId,
  async submitIntake(file: File, title: string) {
    const id = requestId();
    const watermark = bindDeletionWatermark(id);
    await synchronizeDeletion();
    const form = new FormData();
    form.set("extraction", "local");
    form.set("requestId", id);
    form.set("title", title);
    form.set("file", file);
    form.set("deletionWatermark", watermark);
    const response = await fetch("/api/intake", { method: "POST", body: form });
    verifyGenerationReceipt(response, watermark);
    if (!response.ok) throw new Error("文件交入尚未确认，请重试。");
    const value = await response.json() as { id?: string };
    if (!value.id) throw new Error("服务端没有返回材料编号。");
    return value;
  },
};
