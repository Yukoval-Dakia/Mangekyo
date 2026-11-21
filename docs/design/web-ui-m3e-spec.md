# Web UI M3E design contract

## 1. Design intent and non-negotiables

Mangekyō Web is a calm, paper-and-forest learner surface. Wave 1 preserves the existing `<Mark />` component from `surfaces/web/src/icons.tsx` and its four-petal rotated geometry, the existing paper white, forest green, soft green and rail tones, and the quiet, expansive feeling of the current shell. It does not adopt a cold blue-grey system, Indigo, or the former TLP purple.

The redesign targets information architecture, interaction logic, hierarchy, unified design-system state, and missing viewports. It does not replace the brand mark, add decorative motion, or expose implementation identifiers as ordinary learner copy.

## 2. Design tokens

`surfaces/web/src/styles/tokens.css` is the sole source for global tokens. New components use M3E names; legacy aliases keep Wave 2/3 pages usable while they are migrated.

### Light

| Role | Token | Value |
| --- | --- | --- |
| App paper | `--paper` | `#f8faf6` |
| Navigation rail | `--rail` | `#eaf0e7` |
| Brand forest | `--forest` | `#244b36` |
| Soft green | `--soft-green` | `#ddebdc` |
| Primary | `--primary` | `#244b36` |
| Focus | `--focus` | `#236c4f` |
| Surface | `--surface` | `#fbfcf9` |
| Surface container low | `--surface-container-low` | `#f3f6f1` |
| Surface container | `--surface-container` | `#edf2ea` |
| Surface container high | `--surface-container-high` | `#e5ebe2` |
| Ink | `--ink` | `#1d2922` |
| Secondary ink | `--muted` | `#4f6056` |
| Outline | `--line` | `#dce4da` |

### Dark

The dark palette is a warm ink charcoal derived from the same forest-paper gene, with mist forest as the primary accent.

| Role | Token | Value |
| --- | --- | --- |
| App paper | `--paper` | `#101613` |
| Navigation rail | `--rail` | `#16211b` |
| Brand forest | `--forest` | `#a5cfb3` |
| Soft green | `--soft-green` | `#25382e` |
| Primary | `--primary` | `#a5cfb3` |
| Focus | `--focus` | `#9dd7b5` |
| Surface | `--surface` | `#16201a` |
| Surface container low | `--surface-container-low` | `#1b2620` |
| Surface container | `--surface-container` | `#202d25` |
| Surface container high | `--surface-container-high` | `#27372d` |
| Ink | `--ink` | `#edf4ee` |
| Secondary ink | `--muted` | `#a9bcad` |
| Outline | `--line` | `#31453a` |

Both palettes target non-decorative contrast of at least 4.5:1 for body text and 3:1 for large text and meaningful icons. `color-scheme` follows `data-theme`; the explicit user preference is persisted as `mangekyo:theme`, and no preference follows `prefers-color-scheme`.

### Typography and shape

- Page title: 22–26px, weight 650–720, line-height 1.25–1.35, letter-spacing at or above `-0.015em`.
- Section title: 17–20px, line-height 1.4.
- Body and controls: 14–15px, line-height 1.65–1.75.
- Quiet metadata: 12.5–13.5px, line-height 1.5–1.65.
- Expressive card radius is 20–24px; rail controls use capsules; dialog radius is 24–28px.
- Buttons, segmented controls, and navigation use tonal surfaces rather than stacked hairlines.
- KaTeX display blocks stay horizontally scrollable, never widen the page, and inherit the current surface and ink colors.

## 3. Application shell

### Desktop, at least 1024px

- Fixed 72px icon rail on the left.
- `<Mark />` occupies the top brand position and is not redrawn or replaced.
- A rounded expressive `+ 交入` action sits under the mark.
- Four primary capsule destinations follow: `今天` `/today`, `材料` `/materials`, `同伴` `/companion`, `我` `/me`.
- Three silent utility icons sit at the bottom: search/quick capture, theme, and help.
- A top bar contains the breadcrumb and persistent capsule switches for the two right drawers.
- The two drawers are `AI 运作` and `学习同伴`; only one overlays the content at a time and both remain one click away on every route.

### Tablet, 760–1023px

The 72px rail remains until 760px. Content insets contract, drawers become full-height overlays capped at 480px, and the two drawer switches collapse to icon-plus-short-label controls.

### Phone, 375–390px

- The side rail is hidden.
- A top bar retains `<Mark />`, breadcrumb, and drawer switches.
- A bottom M3E navigation bar owns `今天`, `材料`, `同伴`, `我`.
- `+ 交入` is a compact floating action above the navigation bar.
- Utilities remain in the top bar; no horizontal overflow is acceptable (`document.scrollWidth <= document.documentElement.clientWidth`).

## 4. Information architecture and compatibility

The learner-visible model is four primary surfaces plus one unified write entry:

| Surface | Route | Ownership |
| --- | --- | --- |
| Today | `/today` | Current learning state, next action, rhythm, and immediate risk |
| Materials | `/materials` | Sources, papers, practice, classroom, notes, review, textbooks, and intake history |
| Companion | `/companion` | Conversations and current teaching interaction |
| Me | `/me` | Goal, records, settings, memory, and privacy controls |
| Unified intake | `+ 交入` / `/intake` | One sentence, photo, or PDF without forcing a subject or form |

Compatibility mapping:

| Old path | Wave 1 behavior |
| --- | --- |
| `/` | Client-side move to `/today` |
| `/?session=...` | Resolve the real session and move to Companion or first classroom without losing `session` |
| `/plan` | Mount Today |
| `/papers/*` | Mount in the shell under Materials |
| `/practice/*` | Mount in the shell under Materials |
| `/classroom/*` | Mount in the shell under Materials |
| `/intake` | Mount in the shell under Materials |
| `/notes`, `/review` | Mount in the shell under Materials |
| `/textbooks/*` | Mount in the shell under Materials |
| `/materials/*` | Mount in the shell under Materials |

Internal same-origin links use `history.pushState`; `popstate` restores state. Middle-click, Command-click, Control-click, Shift-click, alternate-click, `target="_blank"`, download, mail, and external links retain browser-native behavior.

## 5. Shell behavior

### Quick capture

`⌘K` / `Ctrl+K`, the rail FAB, and the mobile FAB open the same modal. It accepts one sentence, a photo, or a PDF. A sentence writes through the existing real `POST /api/materials`; a file writes through the existing real `POST /api/intake` multipart flow. The modal does not require subject selection and reports unresolved submit outcomes without inventing a receipt.

### Silent help

Help is a quiet bottom-of-rail icon, not a global disclosure. The sheet renders its local 0-LLM support card immediately so it remains usable offline and when no model is configured. When online, it queries `GET /api/care/support` to show the latest 0-LLM support card and any active short-term `carePause` state (`nudges_and_paid_background`), with a learner-initiated one-click 「解除暂停」 action (`POST /api/care/pause/resume`, falling back to `DELETE /api/care/pause`). On offline state or `404`, it degrades calmly to local 0-LLM copy without guessing hotline numbers, auto-contacting any third party, or creating a permanent risk profile.

### AI activity drawer

The drawer first requests the exact contract below. A non-404 failure is shown as a real failure. A 404 or not-ready response triggers parallel fallback reads of existing real endpoints `/api/research/settings`, `/api/today`, and `/api/workspace/access`. Those reads are labeled as fallback evidence; absent information is marked unavailable rather than synthesized. The running indicator is exactly `running.length > 0`.

### Companion drawer

The drawer senses the current route, page title, selected text, and main content heading. `引用当前内容` creates an explicit quoted context block. The pinned bottom footer bar unifies the `本轮用途` segmented radio (`日常学习` or `仅本次回答`), message textarea, and send action. Existing conversations come from real `GET /api/conversations`. Sending continues through the real Companion page and `/api/sessions` route; if no model is available, the drawer says so and does not fabricate a reply. Every future model reply can expose a collapsed `本轮操作与依据` section sourced from the real session trace.

## 6. Wave boundaries

### Wave 1

- Design contract and token source.
- 72px shell, SPA navigation, compatibility shell, dual right drawers, quick capture, help sheet, mobile navigation, and dark mode.
- Existing page components remain mounted and receive the bridged tokens; they are not wholesale rewritten.

### Wave 2

- Consume knowledge graph and memory overview views in Materials and Me.
- Replace remaining page-local typography/card patches progressively.
- Move domain-specific surfaces to the four-container hierarchy without changing backend ownership.

### Wave 3

- Rebuild paper, attempt, attachment, and review flows around the attachment/attempt contracts.
- Consolidate remaining form and print surfaces.
- Remove obsolete page-local bridges only after their last consumer is migrated.

## 7. API contracts

### `GET /api/ai/activity`

```json
{
  "asOf": "string",
  "running": [{
    "id": "string",
    "kind": "teaching | research | retention | intake | assessment | verification | other",
    "slotType": "string",
    "slotKey": "string",
    "deriver": "string",
    "state": "queued | running | waiting | blocked",
    "title": "string",
    "requestedTick": "string",
    "generation": 1,
    "workerProfile": "string | null",
    "chainId": "string | null",
    "hopCount": 0
  }],
  "handoffs": [{
    "id": "string",
    "channel": "night_chain | research | retention | notion",
    "status": "string",
    "title": "string",
    "summary": "string",
    "tick": "string",
    "basisCount": 1,
    "href": "string | null"
  }],
  "recentTools": [{
    "turnId": "string",
    "sessionId": "string",
    "caseId": "string",
    "tick": "string",
    "model": "string",
    "tools": ["string"],
    "toolCount": 1,
    "basisCount": 2,
    "writeCount": 0,
    "href": "string"
  }],
  "usage": {
    "currency": "USD_MICROS",
    "spentMicros": 0,
    "settledMicros": 0,
    "heldMicros": 0,
    "limitMicros": null,
    "recentCalls": [{
      "id": "string",
      "ownerKind": "derivation | session",
      "ownerId": "string",
      "stepKey": "string",
      "label": "string",
      "state": "started | done | unknown",
      "route": "string | null",
      "reservedMicros": null,
      "actualMicros": null,
      "startedTick": "string",
      "endedTick": null
    }]
  },
  "pendingProposals": [{
    "id": "string",
    "kind": "knowledge_edge | graph_evolution | knowledge_entity | textbook_patch | question_draft | question_meta | other",
    "commandType": "string",
    "status": "pending",
    "title": "string",
    "summary": "string",
    "targetId": "string | null",
    "createdTick": "string",
    "actions": { "accept": { "method": "POST", "path": "string" }, "reject": { "method": "POST", "path": "string" }, "inspect": { "method": "GET", "path": "string" } }
  }]
}
```

Degradation: direct response on 200 (UI renders only learner-facing labels and never exposes internal fields such as `slotKey`, `generation`, `tick`, `ownerId`, `stepKey`, or `commandType`); 404/not ready reads fallback endpoints in parallel; network failure retains the drawer and displays retry.

### `GET /api/knowledge/graph`

```json
{
  "asOf": "string",
  "nodes": [{
    "id": "string",
    "rev": 1,
    "title": "string",
    "kind": "concept",
    "mastery": {
      "status": "steady | fading | fragile | unknown",
      "retrievability": 0,
      "independentCount": 0,
      "basisRefs": ["string"]
    },
    "counts": { "questions": 0, "textbooks": 0, "notes": 0, "notionBlocks": 0 }
  }],
  "edges": [{ "id": "string", "rev": 1, "kind": "string", "from": "string", "to": "string", "status": "verified", "basisRefs": ["string"] }],
  "pendingProposals": [{ "id": "string", "kind": "string", "from": "string", "to": "string", "summary": "string", "basisRefs": ["string"] }]
}
```

Wave 2 renders this read model directly. Until available, graph views show an honest unavailable state and existing material routes remain usable.

### `GET /api/memory/overview`

```json
{
  "asOf": "string",
  "categories": { "preference": 0, "claim": 0, "state": 0, "refusal": 0 },
  "stickyDirectives": [{ "id": "string", "rev": 1, "kind": "string", "text": "string", "sticky": true, "basis": "string", "actions": ["string"] }],
  "hypotheses": [{ "id": "string", "rev": 1, "kind": "string", "summary": "string", "status": "string", "basis": "string", "actions": ["string"] }],
  "calibration": {
    "status": "available | unknown",
    "totalReconciliations": 0,
    "confirmed": 0,
    "missed": 0,
    "recent": [{ "key": "string", "status": "string", "conceptId": "string", "occurredAt": "string" }]
  }
}
```

Wave 2 renders memory counts, directives, hypotheses, and calibration from this response only; no inferred memory is displayed as confirmed.

### `POST /api/papers/:id/attachments`

Request is `multipart/form-data` with `file` (PNG, JPEG, or WebP), optional `itemId`, optional `scope: "inherit" | "once"`, and optional `requestId`. Success is `201`:

```json
{ "originalId": "string", "rev": 1, "url": "string", "mimeType": "string", "scope": "inherit | once" }
```

### `POST /api/papers/:id/attempts`

The attempt body may include:

```json
{ "questionAttachments": { "question-id": [{ "originalId": "string", "rev": 1 }] } }
```

The replay/review response may return real-time revalidation:

```json
{
  "questionAttachments": {
    "question-id": [{ "originalId": "string", "rev": 1, "url": "string", "available": true }]
  }
}
```

Unavailable or revoked attachments are shown as unavailable; Wave 3 does not silently substitute another file.

### D10 care support endpoints (`HelpSheet`)

- `GET /api/care/support` returns `200` with `{ "card": OfflineCrisisSupportCard, "pause": { "active": boolean, "scope": "nudges_and_paid_background", "expiresAt": string | null } }`.
- `POST /api/care/pause/resume` (compatible fallback `DELETE /api/care/pause`) clears an active learner care pause and returns `200` with `{ "pause": { "active": false, ... } }`.
- Degradation: local 0-LLM support copy renders immediately before any request completes; offline state or `404` retains local copy without blocking or fabricating numbers.
