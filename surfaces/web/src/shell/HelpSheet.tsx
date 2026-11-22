import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Icon } from "../icons";

type SupportCard = {
  title: string;
  safetyQuestion: string;
  trustedContact: string;
  localEmergencyGuidance: string;
  regionQuestion: string;
  noAutomaticThirdPartyContact: boolean;
  noPermanentProfile: boolean;
};

type CarePauseState = {
  active: boolean;
  scope: string;
  expiresAt: string | null;
};

type SupportResponse = {
  card?: Partial<SupportCard>;
  pause?: Partial<CarePauseState>;
  carePause?: Partial<CarePauseState>;
};

const LOCAL_SUPPORT_CARD: SupportCard = {
  title: "需要帮助",
  safetyQuestion: "你现在眼前安全吗？如果马上有危险，请先离开危险环境并联系当地紧急服务。",
  trustedContact: "可以的话，联系一位你信任的人，让对方现在陪在你身边。",
  localEmergencyGuidance: "如果眼前有危险或已经受伤，请联系你所在地区的急救或危机支持资源；这里不猜测也不编造热线号码。",
  regionQuestion: "需要寻找当地支持时，可以向信任的人或当地机构说明你所在的地区。",
  noAutomaticThirdPartyContact: true,
  noPermanentProfile: true,
};

function nonEmptyString(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function mergeSupportCard(raw?: Partial<SupportCard>): SupportCard {
  if (!raw || typeof raw !== "object") return LOCAL_SUPPORT_CARD;
  return {
    title: nonEmptyString(raw.title, LOCAL_SUPPORT_CARD.title),
    safetyQuestion: nonEmptyString(raw.safetyQuestion, LOCAL_SUPPORT_CARD.safetyQuestion),
    trustedContact: nonEmptyString(raw.trustedContact, LOCAL_SUPPORT_CARD.trustedContact),
    localEmergencyGuidance: nonEmptyString(raw.localEmergencyGuidance, LOCAL_SUPPORT_CARD.localEmergencyGuidance),
    regionQuestion: nonEmptyString(raw.regionQuestion, LOCAL_SUPPORT_CARD.regionQuestion),
    noAutomaticThirdPartyContact: raw.noAutomaticThirdPartyContact !== false,
    noPermanentProfile: raw.noPermanentProfile !== false,
  };
}

function parseCarePause(raw?: Partial<CarePauseState>): CarePauseState | null {
  if (!raw || typeof raw !== "object" || typeof raw.active !== "boolean") return null;
  return {
    active: raw.active,
    scope: typeof raw.scope === "string" && raw.scope ? raw.scope : "nudges_and_paid_background",
    expiresAt: typeof raw.expiresAt === "string" && raw.expiresAt ? raw.expiresAt : null,
  };
}

function formatExpiry(value: string | null) {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function HelpSheet({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [card, setCard] = useState<SupportCard>(LOCAL_SUPPORT_CARD);
  const [pause, setPause] = useState<CarePauseState | null>(null);
  const [source, setSource] = useState<"loading" | "connected" | "fallback">(() =>
    typeof navigator !== "undefined" && navigator.onLine === false ? "fallback" : "loading",
  );
  const [resuming, setResuming] = useState(false);
  const [resumeNotice, setResumeNotice] = useState("");
  const [resumeError, setResumeError] = useState("");

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setSource("fallback");
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/care/support", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          if (!controller.signal.aborted) setSource("fallback");
          return;
        }
        const payload = await response.json() as SupportResponse;
        if (controller.signal.aborted) return;
        setCard(mergeSupportCard(payload.card));
        setPause(parseCarePause(payload.pause ?? payload.carePause));
        setSource("connected");
      } catch {
        if (!controller.signal.aborted) setSource("fallback");
      }
    })();
    return () => controller.abort();
  }, []);

  async function handleResumePause() {
    if (resuming) return;
    setResuming(true);
    setResumeError("");
    setResumeNotice("");
    try {
      let response = await fetch("/api/care/pause/resume", { method: "POST" });
      if (response.status === 404 || response.status === 405) {
        response = await fetch("/api/care/pause", { method: "DELETE" });
      }
      if (!response.ok) {
        throw new Error("暂时无法解除暂停，请联机后重试。");
      }
      const payload = await response.json().catch(() => null) as {
        pause?: Partial<CarePauseState>;
        carePause?: Partial<CarePauseState>;
      } | null;
      const nextPause = parseCarePause(payload?.pause ?? payload?.carePause) ?? {
        active: false,
        scope: pause?.scope ?? "nudges_and_paid_background",
        expiresAt: null,
      };
      setPause(nextPause);
      setResumeNotice("已解除短期关怀暂停，催练与后台教研可按你的设置恢复。");
    } catch (failure) {
      setResumeError(failure instanceof Error ? failure.message : "暂时无法解除暂停，请联机后重试。");
    } finally {
      setResuming(false);
    }
  }

  function handleBackdrop(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === ref.current) onClose();
  }

  const formattedExpiry = formatExpiry(pause?.expiresAt ?? null);

  return (
    <dialog ref={ref} className="help-dialog" aria-labelledby="help-title" onClose={onClose} onClick={handleBackdrop}>
      <header className="dialog-heading">
        <div>
          <h2 id="help-title">{card.title}</h2>
          <p>把常用操作、快捷键和安全说明放在一处；离线也能查看。</p>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭帮助"><Icon name="close" /></button>
      </header>
      <div className="help-body">
        <section className="help-card help-quick-card" aria-labelledby="help-quick-title">
          <h3 id="help-quick-title">快速上手</h3>
          <div className="help-columns">
            <div>
              <h4>快速交入</h4>
              <ul>
                <li><kbd>⌘K</kbd> 打开快速搜索与交入</li>
                <li><kbd>⌘</kbd> + <kbd>Enter</kbd> 发送当前消息或提交</li>
                <li>拍卷、传 PDF，或先写一句话记录材料</li>
              </ul>
            </div>
            <div>
              <h4>四个主表面</h4>
              <ul>
                <li>今天：安排、节奏与今日建议</li>
                <li>材料：试卷、错题、教材与来源</li>
                <li>同伴：对话、练习与陪伴</li>
                <li>我：目标、记忆与设置</li>
              </ul>
            </div>
          </div>
        </section>

        <section className="help-card" aria-label="基础安全支持">
          <h3>安全与离线支持</h3>
          <p>{card.safetyQuestion}</p>
          <p>{card.trustedContact}</p>
          <p>{card.localEmergencyGuidance}</p>
          <p>{card.regionQuestion}</p>
        </section>

        {source === "connected" && pause?.active && (
          <section className="help-pause-card" data-active="true" aria-label="短期关怀暂停状态">
            <div className="help-pause-copy">
              <strong>已短期暂停催练与付费后台教研</strong>
              <p>
                {formattedExpiry
                  ? `预计 ${formattedExpiry} 到期后自动恢复；你也可以随时主动解除这项暂停。`
                  : "这项暂停仅用于减少打扰，你随时可以主动解除。"}
              </p>
            </div>
            <button
              className="tonal-button"
              type="button"
              onClick={() => void handleResumePause()}
              disabled={resuming}
            >
              {resuming ? "正在解除…" : "解除暂停"}
            </button>
          </section>
        )}

        {source === "connected" && pause && !pause.active && (
          <div className="help-pause-card" data-active="false" role="status">
            <p>{resumeNotice || "当前未开启短期关怀暂停。"}</p>
          </div>
        )}

        {resumeError && <p className="error-text" role="alert">{resumeError}</p>}

        <p className="help-assurance">
          {card.noAutomaticThirdPartyContact ? "不会自动联系家长、老师、警方或其他第三方。" : ""}
          {card.noPermanentProfile ? "不会创建永久“高危学习者”档案，也不会调用模型处理这段求助。" : ""}
          {source === "fallback" ? "当前展示本地离线支持说明，无需联网即可随时打开。" : ""}
        </p>
      </div>
      <div className="dialog-actions">
        <button className="primary-button" type="button" onClick={onClose}>我知道了</button>
      </div>
    </dialog>
  );
}
