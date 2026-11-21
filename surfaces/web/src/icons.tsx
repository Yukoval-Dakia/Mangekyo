export type IconName = "settings" | "plus" | "send" | "chevron" | "close" | "history" | "document" | "arrow" | "today" | "book" | "chat" | "person" | "practice" | "lock" | "search" | "activity" | "theme" | "sun" | "help";

const paths: Record<IconName, React.ReactNode> = {
  today: <><rect x="3.5" y="5" width="17" height="16" rx="3" /><path d="M7.5 3v4m9-4v4m-13 3.5h17M8 14h4" /></>,
  book: <><path d="M12 6c-3-2.5-6-2.5-9-1v14c3-1.5 6-1.4 9 1 3-2.4 6-2.5 9-1V5c-3-1.5-6-1.5-9 1Zm0 0v14" /></>,
  chat: <path d="M4 5.5c0-1 1-2 2.5-2h11c1.5 0 2.5 1 2.5 2v9c0 1-1 2-2.5 2H11L6 21v-4.5H5.5c-1 0-1.5-.8-1.5-2Zm4 3h8m-8 4h4" />,
  person: <><circle cx="12" cy="8" r="3.5" /><path d="M4.5 20c.5-4 3-6 7.5-6s7 2 7.5 6" /></>,
  practice: <><path d="m5 16-1 5 5-1L20 9l-4-4L5 16Zm9-9 4 4M3 4h7M3 8h4" /></>,
  lock: <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v2" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.1h-4v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1-2.8-2.8.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3v-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1L7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.5V3h4v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1 2.8 2.8-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1v4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  send: <path d="m5 12 15-8-4 16-4-5-4 3v-5l12-9" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  history: <><path d="M3 9a9 9 0 1 1 .8 6M3 4v5h5" /><path d="M12 7v5l3 2" /></>,
  document: <><path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6" /></>,
  arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,
  activity: <><path d="M3 13h4l2.5-6 4 12 2.5-6H21" /></>,
  theme: <path d="M20 13.5A8.2 8.2 0 0 1 10.5 4 8.5 8.5 0 1 0 20 13.5Z" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2.2m0 14.6v2.2M4.7 4.7l1.6 1.6m11.4 11.4 1.6 1.6M2.5 12h2.2m14.6 0h2.2M4.7 19.3l1.6-1.6m11.4-11.4 1.6-1.6" /></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.4 9.2a2.7 2.7 0 1 1 3.8 2.8c-.8.5-1.2 1-1.2 2M12 17h.01" /></>,
};

export function Icon({ name }: { name: IconName }) {
  return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

export function Mark({ className }: { className?: string }) {
  return <span aria-hidden="true" className={`mark ${className ?? ""}`}><i /><i /><i /><i /></span>;
}
