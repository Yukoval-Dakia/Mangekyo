import type { ReactNode } from "react";

export const PRIVACY_HREF = "/me?section=privacy";

export function readableDetail(raw: string | undefined, max = 160) {
  const text = raw?.trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function RecoveryGuide({
  status,
  detail,
  onResend,
  resendLabel = "重新发送",
  resendDisabled,
  onOpenPrivacy,
  children,
}: {
  status: "unknown" | "failed" | "blocked";
  detail?: string | undefined;
  onResend?: (() => void) | undefined;
  resendLabel?: string;
  resendDisabled?: boolean | undefined;
  onOpenPrivacy?: (() => void) | undefined;
  children?: ReactNode;
}) {
  const summary = readableDetail(detail);
  const text = status === "unknown"
    ? "模型或工具执行尚未完成确认，已安全暂停自动继续：不会重复扣费，也不会误改你的内容。你可以重新发送上一条输入，或先前往开启工作区权限后再继续。"
    : status === "blocked"
      ? "这项任务已安全暂停：不会重复扣费，也不会继续改动你的内容。前往核对并重新放行后才会继续。"
      : "这一回合没有完成，已安全停下：不会重复扣费，也不会误改你的内容。你可以重新发送上一条输入，或先前往开启工作区权限后再继续。";
  return (
    <div className="notice problem recovery-guide" role="alert">
      <p>
        {text}
        {summary && <span className="recovery-detail">详情：{summary}</span>}
      </p>
      {children}
      <div className="recovery-actions">
        {onResend && (
          <button type="button" className="tonal-button" onClick={onResend} disabled={resendDisabled}>
            {resendLabel}
          </button>
        )}
        <a
          className="text-button"
          href={PRIVACY_HREF}
          onClick={event => {
            if (!onOpenPrivacy) return;
            event.preventDefault();
            onOpenPrivacy();
          }}
        >
          前往开启工作区权限
        </a>
      </div>
    </div>
  );
}
