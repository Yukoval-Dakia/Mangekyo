import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Icon, Mark, type IconName } from "../icons";
import { remembered, remember, type Settings } from "../api";
import type { CurrentObject } from "../current-record";
import { OfflineStatus } from "../offline-status";
import type { ChatLink, Material, Resource } from "../workspace";
import { AiActivityDrawer } from "./AiActivityDrawer";
import { CompanionDrawer } from "./CompanionDrawer";
import { HelpSheet } from "./HelpSheet";
import { QuickCaptureModal, type QuickModalMode } from "./QuickCaptureModal";

export const destinations: { path: string; text: string; icon: IconName }[] = [
  { path: "/today", text: "今天", icon: "today" },
  { path: "/materials", text: "材料", icon: "book" },
  { path: "/companion", text: "同伴", icon: "chat" },
  { path: "/me", text: "我", icon: "person" },
];

export type CompanionCitationPayload = {
  title: string;
  text: string;
  topic?: string;
  currentObject?: CurrentObject | undefined;
  focusLabel?: string | undefined;
};

export const CITE_TO_COMPANION_EVENT = "mangekyo:cite-to-companion";

export function citeToCompanionDrawer(citation: CompanionCitationPayload) {
  window.dispatchEvent(new CustomEvent<CompanionCitationPayload>(CITE_TO_COMPANION_EVENT, { detail: citation }));
}

export const OPEN_HELP_SHEET_EVENT = "mangekyo:open-help";

export function openHelpSheet() {
  window.dispatchEvent(new CustomEvent(OPEN_HELP_SHEET_EVENT));
}

function applyThemeToDocument(theme: "light" | "dark") {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = theme === "dark" ? "#16211b" : "#eaf0e7";
}

export function AppShell({
  route,
  active,
  breadcrumb,
  settings,
  chats,
  materials,
  onNavigate,
  onOpenSettings,
  onSavedMaterial,
  aiActivityRequest,
  companionCitation,
  children,
}: {
  route: string;
  active: string;
  breadcrumb: string[];
  settings: Settings | undefined;
  chats: Resource<ChatLink[]>;
  materials: Material[];
  onNavigate: (href: string, replace?: boolean) => void;
  onOpenSettings: () => void;
  onSavedMaterial: (href: string) => void;
  aiActivityRequest?: number | undefined;
  companionCitation?: (CompanionCitationPayload & { seq: number }) | undefined;
  children: ReactNode;
}) {
  const [drawer, setDrawer] = useState<"none" | "ai" | "companion">("none");
  const [quickModal, setQuickModal] = useState<QuickModalMode | null>(null);
  const [help, setHelp] = useState(false);
  const [running, setRunning] = useState(false);
  const lastAiRequest = useRef(0);
  const [eventCitation, setEventCitation] = useState<(CompanionCitationPayload & { seq: number }) | undefined>(undefined);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = remembered("theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    if (!aiActivityRequest || aiActivityRequest === lastAiRequest.current) return;
    lastAiRequest.current = aiActivityRequest;
    setDrawer("ai");
  }, [aiActivityRequest]);

  useEffect(() => {
    if (companionCitation) setDrawer("companion");
  }, [companionCitation]);

  useEffect(() => {
    function onCite(event: Event) {
      const detail = (event as CustomEvent<CompanionCitationPayload>).detail;
      if (!detail || typeof detail.title !== "string" || typeof detail.text !== "string") return;
      setEventCitation((previous) => ({ ...detail, seq: (previous?.seq ?? 0) + 1 }));
      setDrawer("companion");
    }
    window.addEventListener(CITE_TO_COMPANION_EVENT, onCite);
    return () => window.removeEventListener(CITE_TO_COMPANION_EVENT, onCite);
  }, []);

  useEffect(() => {
    function onOpenHelp() {
      setHelp(true);
    }
    window.addEventListener(OPEN_HELP_SHEET_EVENT, onOpenHelp);
    return () => window.removeEventListener(OPEN_HELP_SHEET_EVENT, onOpenHelp);
  }, []);

  const effectiveCitation = eventCitation ?? companionCitation;

  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    function syncSystemTheme() {
      if (!remembered("theme")) setTheme(query.matches ? "dark" : "light");
    }
    query.addEventListener("change", syncSystemTheme);
    return () => query.removeEventListener("change", syncSystemTheme);
  }, []);

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setDrawer("none");
        setQuickModal("search");
      }
      if (event.key === "Escape") setDrawer("none");
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);

  function switchTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    remember("theme", next);
  }

  function navigate(href: string) {
    setDrawer("none");
    setQuickModal(null);
    onNavigate(href);
  }

  function interceptLinks(event: MouseEvent<HTMLDivElement>) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!(target instanceof HTMLAnchorElement)) return;
    if (target.target && target.target !== "_self") return;
    if (target.hasAttribute("download")) return;
    const rawHref = target.getAttribute("href");
    if (!rawHref || rawHref.startsWith("#")) return;
    let url: URL;
    try {
      url = new URL(target.href, window.location.origin);
    } catch {
      return;
    }
    if (url.origin !== window.location.origin) return;
    if (url.pathname.startsWith("/api/")) return;
    event.preventDefault();
    navigate(url.pathname + url.search + url.hash);
  }

  const nav = (className: string) => (
    <nav className={className} aria-label="主导航">
      {destinations.map(destination => (
        <a
          key={destination.path}
          href={destination.path}
          aria-current={active === destination.path ? "page" : undefined}
          aria-label={destination.text}
        >
          <span className="rail-nav-pill">
            <Icon name={destination.icon} />
          </span>
          <span>{destination.text}</span>
        </a>
      ))}
    </nav>
  );

  return (
    <div className="product-shell" data-drawer={drawer} onClick={interceptLinks}>
      <a className="skip-content" href="#main-content">跳到正文</a>
      <aside className="side-rail" aria-label="全局导航">
        <a className="rail-brand" href="/today" aria-label="Mangekyō 首页">
          <Mark />
        </a>
        <button className="rail-fab" type="button" onClick={() => setQuickModal("capture")} aria-label="交入材料">
          <Icon name="plus" />
          <span>交入</span>
        </button>
        {nav("rail-nav")}
        <div className="rail-utilities">
          <button type="button" onClick={() => setQuickModal("search")} aria-label="快速搜索与交入（⌘K）" title="快速搜索与交入（⌘K）">
            <Icon name="search" />
          </button>
          <button
            type="button"
            onClick={switchTheme}
            aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
            title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
          >
            <Icon name={theme === "dark" ? "sun" : "theme"} />
          </button>
          <button type="button" onClick={() => setHelp(true)} aria-label="需要帮助" title="需要帮助">
            <Icon name="help" />
          </button>
        </div>
      </aside>

      <div className="shell-body">
        <header className="app-top-bar">
          <div className="top-left">
            <a className="top-brand" href="/today" aria-label="Mangekyō 首页">
              <Mark />
            </a>
            <nav className="breadcrumb" aria-label="当前位置">
              {breadcrumb.map((item, index) => (
                <span key={item + index}>
                  {index > 0 && <i className="breadcrumb-sep" aria-hidden="true">/</i>}
                  {item}
                </span>
              ))}
            </nav>
          </div>
          <div className="top-actions">
            <button
              className="drawer-switch"
              type="button"
              aria-pressed={drawer === "ai"}
              aria-label="AI 运作"
              onClick={() => setDrawer(drawer === "ai" ? "none" : "ai")}
            >
              <Icon name="activity" />
              <span className="drawer-switch-label">AI 运作</span>
              <i className={running ? "breathing live" : "breathing"} aria-hidden="true" />
              <span className="visually-hidden">{running ? "有任务运行中" : "没有任务运行中"}</span>
            </button>
            <button
              className="drawer-switch"
              type="button"
              aria-pressed={drawer === "companion"}
              aria-label="学习同伴"
              onClick={() => setDrawer(drawer === "companion" ? "none" : "companion")}
            >
              <Icon name="chat" />
              <span className="drawer-switch-label">学习同伴</span>
            </button>
            <button
              className="icon-button top-mobile-utility"
              type="button"
              onClick={switchTheme}
              aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
            >
              <Icon name={theme === "dark" ? "sun" : "theme"} />
            </button>
            <button
              className="icon-button top-mobile-utility"
              type="button"
              onClick={() => setHelp(true)}
              aria-label="需要帮助"
            >
              <Icon name="help" />
            </button>
            <button className="icon-button" type="button" onClick={onOpenSettings} aria-label="学习设置">
              <Icon name="settings" />
            </button>
          </div>
        </header>
        <main id="main-content" className="page-body">
          <OfflineStatus />
          {children}
        </main>
      </div>

      <button className="mobile-fab" type="button" onClick={() => setQuickModal("capture")}>
        <Icon name="plus" />
        <span>交入</span>
      </button>
      {nav("mobile-nav")}

      <div className="drawer-scrim" data-open={drawer !== "none"} onClick={() => setDrawer("none")} aria-hidden="true" />
      <AiActivityDrawer
        open={drawer === "ai"}
        onClose={() => setDrawer("none")}
        onNavigate={navigate}
        onRunningChange={setRunning}
      />
      <CompanionDrawer
        open={drawer === "companion"}
        route={route}
        pageLabel={breadcrumb.join(" / ") || "今天"}
        settings={settings}
        chats={chats}
        onClose={() => setDrawer("none")}
        onOpenCompanion={navigate}
        onOpenSettings={() => {
          setDrawer("none");
          onOpenSettings();
        }}
        pendingCitation={effectiveCitation}
      />
      {quickModal && (
        <QuickCaptureModal
          initialMode={quickModal}
          materials={materials}
          chats={chats.data ?? []}
          onClose={() => setQuickModal(null)}
          onSaved={href => {
            setQuickModal(null);
            onSavedMaterial(href);
          }}
          onNavigate={navigate}
        />
      )}
      {help && <HelpSheet onClose={() => setHelp(false)} />}
    </div>
  );
}
