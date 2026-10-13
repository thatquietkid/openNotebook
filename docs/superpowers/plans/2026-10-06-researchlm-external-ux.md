# ResearchLM External User UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ResearchLM easy for a first-time external user to explore the example notebook, add sources, ask cited questions, and use Studio with clear, accessible feedback.

**Architecture:** Keep the existing vanilla HTML/CSS/JavaScript workspace and FastAPI/SQLite backend. Add contextual notebook states and in-place feedback, make source selection semantics explicit at the database boundary, and refine responsive and keyboard behavior without changing retrieval, prompts, storage schema, or adding dependencies.

**Tech Stack:** Static HTML, CSS, vanilla JavaScript, FastAPI, SQLite, existing Go document processor.

**Spec:** `docs/superpowers/specs/2026-10-06-researchlm-external-ux-design.md`

## Global Constraints

- Preserve the existing notebook workspace; do not add a separate marketing home or multi-step setup wizard.
- On a fresh database, identify `default-research` and its `attention.pdf` as example material and make it usable immediately.
- For an empty notebook, reuse the existing upload and sample-import endpoints and offer both actions.
- Treat `active_source_ids is None` as all sources and `active_source_ids == []` as no sources.
- Do not search all sources when the user has deselected every source.
- Reuse existing APIs and add no frontend framework or dependency.
- Keep ResearchLM's dark workbench and Inter typography; use indigo-blue for selection/focus and a distinct citation treatment.
- The Studio podcast action must be labeled **Podcast script**, since its current endpoint returns dialogue text, not audio.
- Add responsive layout, keyboard-operable controls, dialog focus handling, live status announcements, and reduced-motion support.
- Do not change retrieval algorithms, LLM prompts, database schema, or artifact-generation capability.

## Review Focus

- `None` and `[]` must have distinct search behavior, including both chat and Studio requests. Owner: Task 1.
- The preloaded example must be identified, while new empty notebooks still show upload/sample actions. Owner: Task 2.
- Multiple uploads with one failure must keep the successful sources and expose a retry for the failed file. Owner: Task 3.
- Studio actions must accurately describe and show progress for generated text artifacts, and be unavailable with no active sources. Owner: Task 4.
- On narrow screens and with keyboard navigation, the drawer and dialogs must remain operable without hiding focus or trapping it outside the active dialog. Owner: Tasks 5 and 6.

> **Review approach:** The workspace instruction for this task is to avoid adding or running tests unless requested. Review each task's resulting code and interface against its listed behavior; no test files or test commands are part of this plan.

---

### Task 1: Make empty source selection explicit

**Files:**
- Modify: `backend/app/database.py` — `vector_search`
- Modify: `frontend/app.js` — chat request, source toggle state, and chat availability
- Modify: `frontend/index.html` — active-source summary and selection guidance

**Interfaces:**
- Consumes: `ChatRequest.active_sources: Optional[List[str]]` and `vector_search(notebook_id, query_vector, active_source_ids, top_k)`.
- Produces: `None` retains the existing all-sources behavior; an empty list returns no chunks; a non-empty list searches only those sources.

- [x] **Step 1: Add the selection summary and guidance markup**

Add an element in the source panel for the current count and a short status below the chat composer for the no-selection state:

```html
<p id="activeSourceSummary" aria-live="polite"></p>
<p id="sourceSelectionHint" class="input-hint hidden">Select at least one source to ask a question.</p>
```

- [x] **Step 2: Make SQLite search return no rows for an explicit empty list**

In `vector_search`, before building a SQL `IN` clause, preserve `None` for the unfiltered query and return immediately for an empty list:

```python
if active_source_ids is not None and not active_source_ids:
    return []

if active_source_ids is not None:
    placeholders = ",".join("?" for _ in active_source_ids)
```

Use the existing filtered query for non-empty lists and the existing unfiltered query only for `None`.

- [x] **Step 3: Send the selected IDs without converting an empty selection to `null`**

In `sendMessage`, build the request from `Array.from(state.activeSources)` even when that array is empty:

```js
const activeSourceIds = Array.from(state.activeSources);
body: { query, active_sources: activeSourceIds, top_k: 6 }
```

- [x] **Step 4: Refresh source count and chat availability whenever selection changes**

Add a helper that updates the summary, disables sending when the set is empty, and toggles the guidance. Call it after selecting a notebook and after each source checkbox change. Keep the text input available for reading/editing a draft, but disable the send button while no sources are active.

- [x] **Step 5: Ensure Studio sends the same explicit selection**

Build `active_sources` as `Array.from(state.activeSources)` in `generateStudioArtifact`. Let the database return no chunks for `[]`; keep the UI action disabled as defined in Task 4.

- [x] **Step 6: Review the three selection states in code**

Confirm that the request path and database path preserve the distinction among `null`, `[]`, and a non-empty array, and that no empty state falls back to all notebook sources.

---

### Task 2: Add contextual first-use and notebook states

**Files:**
- Modify: `frontend/index.html` — welcome/setup actions and notebook empty state
- Modify: `frontend/app.js` — notebook/source-aware welcome content, sample import, notebook creation handoff
- Modify: `frontend/index.css` — setup state hierarchy and button styling

**Interfaces:**
- Consumes: `GET /api/notebooks`, `GET /api/notebooks/{id}`, existing notebook creation, and `POST /api/notebooks/{id}/sources/import-sample`.
- Produces: a demo welcome for the seeded notebook; upload/sample actions for an empty notebook; source-aware question starters once sources exist.

- [x] **Step 1: Add a reusable welcome state with primary and secondary actions**

Restructure `#welcomeState` to contain a heading, short explanation, `#welcomeActions`, and `#welcomeSuggestions`. Keep the upload action connected to the existing hidden file input.

- [x] **Step 2: Render the seeded example state from actual notebook/source data**

In `selectNotebook`, after loading `nb.sources`, detect the seeded example using `nb.id === 'default-research'`. Identify the sample source by its `attention.pdf` filename. Show an “Example notebook” label and sample-specific starter questions when present. If the seeded notebook has no imported sample, present the ordinary empty-source actions rather than claiming the sample is ready.

- [x] **Step 3: Render empty notebook actions**

When `state.sources.length === 0`, show **Upload a document** and **Try a sample**. Connect the sample button to the current endpoint:

```js
await api(`/notebooks/${state.activeNotebookId}/sources/import-sample`, {
    method: 'POST',
});
```

After success, reload the selected notebook and show the added source. Surface a useful error if import fails.

- [x] **Step 4: Render source-aware chat welcome after import/upload**

When sources exist, show question suggestions relevant to the user’s sources and keep the active-source summary from Task 1 visible. Hide setup actions so the main next step is asking a question.

- [x] **Step 5: Make a genuinely empty notebook list actionable**

If `loadNotebooks` returns no notebooks, render a main-area explanation and a **Create notebook** action that opens the existing new-notebook modal. After creation, select the new notebook and show its empty-source actions.

- [x] **Step 6: Review the seeded, empty, and sourced states in code**

Trace `loadNotebooks`, `selectNotebook`, upload completion, and sample import completion. Confirm that each state renders the correct action and that no sample-ready copy appears when its source is absent.

---

### Task 3: Replace blocking upload feedback with inline file states

**Files:**
- Modify: `frontend/index.html` — upload status list in the source panel
- Modify: `frontend/app.js` — upload queue state, per-file result rendering, retry handler
- Modify: `frontend/index.css` — compact upload status and retry treatment

**Interfaces:**
- Consumes: existing upload API response including `chunk_count`, and existing upload input/drop handlers.
- Produces: per-file processing, success, or failure state with a retry action for failed files.

- [x] **Step 1: Add an inline upload status region**

Place an `aria-live="polite"` status list next to `#sourcesList`, not in the blocking `#loadingOverlay`.

- [x] **Step 2: Track each file as it is submitted**

Add `uploadJobs` to frontend state. Give each submitted `File` a stable local job key and one status value (`processing`, `added`, or `failed`). Preserve the `File` object for a retry; do not invent a percentage because the current `fetch` path does not expose true upload progress.

- [x] **Step 3: Render upload state and success details**

Add `renderUploadJobs()` to render filename, current state, successful chunk count, and any error. Make a retry control available only for failed jobs. Update `uploadFiles` to refresh sources after successful jobs while preserving failures from the same batch.

- [x] **Step 4: Add a single-file retry path**

Implement `retryUpload(jobKey)` by resubmitting the retained `File` through the existing `uploadFiles` request path. Clear the prior error when retry begins and replace it with the new result.

- [x] **Step 5: Keep drag-and-drop and file-picker paths consistent**

Route both event handlers through the same queue implementation. Remove the whole-screen upload overlay from this flow and prevent duplicate submission of a file while its job is processing.

- [x] **Step 6: Review mixed upload outcomes in code**

Confirm successful files remain in the source list when another file fails, each failure is actionable, and a retry updates only its matching job.

---

### Task 4: Clarify Studio output and generation feedback

**Files:**
- Modify: `frontend/index.html` — Studio action title, descriptions, and status markup
- Modify: `frontend/app.js` — per-action progress/disabled state and error feedback
- Modify: `frontend/index.css` — selected-action progress and disabled styles

**Interfaces:**
- Consumes: existing Studio endpoints and `state.activeSources`.
- Produces: accurate podcast-script wording and action-local progress, success, and failure feedback.

- [x] **Step 1: Rename the audio feature in the visible interface**

Change the card title to **Podcast script** and describe it as a two-host dialogue script. Keep endpoint path `/studio/podcast` unchanged.

- [x] **Step 2: Add an action-local status element**

Add a status area to each Studio action card with `aria-live="polite"`. Do not use the global blocking overlay for Studio generation.

- [x] **Step 3: Disable unavailable actions and protect duplicate requests**

Disable the Studio actions when `state.activeSources.size === 0`, expose a short select-source hint, and disable only the action currently generating until its request completes.

- [x] **Step 4: Render generation outcomes beside the action**

Set the action state before the API request, then replace it with a generated confirmation or the API error. Preserve the artifact list refresh and allow the resulting artifact to open through the existing viewer.

- [x] **Step 5: Review the output promise and request lifecycle in code**

Confirm no interface copy promises audio playback, duplicate clicks cannot issue concurrent generation for one action, and the error state is visible and announced.

---

### Task 5: Make the workspace responsive

**Files:**
- Modify: `frontend/index.html` — sidebar backdrop and expanded-state metadata
- Modify: `frontend/app.js` — drawer open/close and viewport-aware state
- Modify: `frontend/index.css` — narrow-screen layout and focus-visible tokens

**Interfaces:**
- Consumes: existing sidebar toggle and `.collapsed` desktop state.
- Produces: desktop sidebar behavior plus a drawer that can open and close on narrow screens.

- [x] **Step 1: Add a backdrop and accessible sidebar toggle metadata**

Add a hidden backdrop next to the sidebar and give `#btnToggleSidebar` `aria-controls="sidebar"` and an initial `aria-expanded="true"`.

- [x] **Step 2: Implement drawer state and close behavior**

Update the sidebar button handler to toggle drawer state on narrow screens, synchronize `aria-expanded`, and close on backdrop click. Preserve the current collapse control on desktop.

- [x] **Step 3: Add narrow-screen layout rules**

Add a media query that turns the sidebar into a fixed-width overlay drawer, constrains chat and dialog widths to the viewport, and keeps the composer above the mobile bottom edge. Prevent horizontal overflow.

- [x] **Step 4: Add clear keyboard focus styling to interactive elements**

Use a shared `:focus-visible` outline based on `--border-focus` for buttons, input controls, source toggles, and dynamic action controls.

- [x] **Step 5: Review desktop and narrow-screen CSS states in source**

Check that the desktop collapse behavior remains separate from the mobile drawer and that no narrow-screen rule hides the chat composer or modal close control.

---

### Task 6: Make dynamic controls and dialogs keyboard accessible

**Files:**
- Modify: `frontend/index.html` — landmark, dialog, status, and icon-button semantics
- Modify: `frontend/app.js` — dynamic semantic controls, Escape handling, focus trap/restore, announcements
- Modify: `frontend/index.css` — reduced-motion overrides

**Interfaces:**
- Consumes: dynamic notebook, source, citation, artifact, and modal rendering.
- Produces: named, keyboard-operable controls and dialogs with predictable focus behavior.

- [x] **Step 1: Add names and semantics to page regions and icon controls**

Name the sidebar and main landmarks; add accessible labels to icon-only controls; add dialog roles, `aria-modal="true"`, and `aria-labelledby` to each modal overlay.

- [x] **Step 2: Render dynamic clickable rows as semantic buttons**

Render notebook entries, artifact entries, source-preview actions, and citation references as buttons. Associate each source checkbox with an accessible label containing its filename. Preserve event behavior without inline `onclick` handlers.

- [x] **Step 3: Manage dialog focus lifecycle**

When a dialog opens, save the triggering element and focus the dialog's first interactive control. Keep Tab focus within the open dialog. On close, return focus to the trigger. Close the topmost dialog and mobile drawer on Escape.

- [x] **Step 4: Announce async outcomes and respect reduced motion**

Use a polite live region for upload/chat/Studio progress and completion, and an alert region for failures. Add a `prefers-reduced-motion: reduce` block that disables nonessential transitions and spinner-adjacent entrance effects without removing state information.

- [x] **Step 5: Review keyboard and status semantics across rendered states**

Trace modal open/close, drawer open/close, dynamic rows, upload retry, citation opening, and Studio outcomes. Confirm keyboard focus remains visible and status text is announced once per state change.

---

## Execution Handoff

The tasks touched six interaction areas but shared one frontend state model and source-selection behavior. The user approved **Native execution**, and all six steps are complete.



