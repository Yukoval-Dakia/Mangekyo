import { openHelpSheet } from "./AppShell";

export function CarePauseNotice({ disabled = false }: { disabled?: boolean }) {
  return (
    <aside className="care-pause-notice" role="status" aria-label="关怀暂停说明">
      <div className="care-pause-notice-copy">
        <strong>关怀暂停已开启</strong>
        <p>已暂时静音 24 小时催练与付费后台教研；本轮未调用模型，也不会自动联系第三方。</p>
      </div>
      <button
        type="button"
        className="tonal-button care-pause-notice-action"
        disabled={disabled}
        onClick={openHelpSheet}
      >
        查看安全支持 / 解除暂停
      </button>
    </aside>
  );
}
