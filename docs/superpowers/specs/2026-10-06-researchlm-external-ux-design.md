# ResearchLM External User UX Design

## Goal

Help a first-time external user move from opening ResearchLM to exploring a source, asking a cited question, and optionally generating a Studio artifact without needing setup instructions.

## Audience and success

The primary user is an external user who may not know the implementation or RAG terminology. The interface should make the next useful action clear at each stage and set accurate expectations about what the app produces.

The first-use journey is successful when a user can:

1. Recognize the preloaded Transformer notebook as example material, or create a notebook of their own.
2. Upload a supported document or add the sample paper to a new notebook.
3. See which sources are included in a question and ask a question grounded in those sources.
4. Open a citation and inspect its source excerpt.
5. Generate and reopen a Studio artifact, with the podcast feature clearly described as a text script.

## Approved direction

Keep the current notebook workspace and improve the guidance within it. Do not add a separate marketing home or a multi-step setup wizard. The first-use experience is contextual: an existing example notebook is labeled as a demo, an empty notebook presents upload and sample actions, and a notebook with active sources presents useful question starters.

## Visual language and layout

- Preserve ResearchLM's dark workbench identity and existing Inter typography.
- Keep the indigo-blue accent for selection and focus. Use a distinct citation treatment so evidence markers are easy to identify in answers.
- Strengthen hierarchy through spacing, type size, and contrast; reduce decorative card repetition and glow effects.
- On desktop, keep notebook/source navigation in a left sidebar and setup or chat in the main workspace.
- On small screens, present the sidebar as a drawer controlled from the top bar. Keep the chat composer and modal actions usable within the viewport.
- Respect reduced-motion preferences and provide visible keyboard focus.

## First-use and notebook states

### Preloaded example notebook

On a fresh database, the backend creates the `default-research` notebook and attempts to import `attention.pdf`. The UI must identify this content as a sample/example, explain that the source is already available, and offer question starters based on it. Do not prompt the user to upload a source before they can try chat in this notebook.

### Empty user-created notebook

When a selected notebook has no sources, show two clear actions in the main workspace:

- **Upload a document** opens the existing file picker and accepts the currently supported PDF, TXT, Markdown, CSV, and JSON formats.
- **Try a sample** imports the existing `attention.pdf` sample through the current sample-import endpoint.

After a source is ready, replace the empty setup content with a source-aware chat welcome and useful question suggestions.

### No notebook state

If the notebook list is empty, show an explicit create-notebook action and a short explanation instead of leaving the main area at “Select a Notebook.”

## Source selection and grounded chat

- Show the active-source count in the source area and keep each source's selection visible.
- Keep the send action unavailable when there are no active sources and provide a short instruction to select a source.
- Send an explicit empty source list when the user has deselected all sources. The backend must interpret `None` as all notebook sources and an empty list as no sources; it must never widen an empty selection to all sources.
- Preserve inline citation markers. Render citation references as keyboard-accessible controls that open the source preview for the cited source.
- If no chunks are retrieved, explain that there is no selected source material to answer from rather than implying a grounded answer was generated.

## Upload and Studio feedback

- Replace the blocking whole-screen upload overlay with inline per-file states: processing, added with a chunk count, or failed with a clear error and retry path. Do not present a numeric upload percentage unless the browser reports real transfer progress.
- Keep the workspace visible during upload; show progress inline and disable only the file's duplicate upload action while it is processing.
- Show Studio generation progress on the selected action and report completion or the specific failure. Disable generation when no sources are active.
- Rename **Audio Overview** to **Podcast script** in the UI because the current endpoint generates dialogue text and does not create audio playback.
- Generated artifacts remain accessible from the existing artifact list and viewer.

## Responsive behavior and accessibility

- Use a compact responsive breakpoint for the sidebar drawer, source list, chat composer, and dialogs; avoid horizontal overflow on narrow screens.
- Make notebooks, sources, citations, and artifacts operable by keyboard using semantic controls.
- Provide accessible names for icon-only buttons, labels for inputs, dialog semantics, visible focus indicators, Escape-to-close for dialogs/drawer, focus trapping while a dialog is open, and focus restoration after it closes.
- Announce upload, chat, and Studio status changes through a polite live region; announce failures as alerts.
- Respect `prefers-reduced-motion` for transitions and animations.

## Scope and implementation boundaries

- Main UI work is limited to `frontend/index.html`, `frontend/index.css`, and `frontend/app.js`.
- A small backend change is required for the empty active-source semantics in `backend/app/database.py` (and the existing chat route in `backend/app/main.py` only if request normalization is needed).
- Reuse the existing notebook, source upload, sample import, chat, citation preview, and Studio artifact endpoints. Do not add a new frontend framework or dependency.
- This design does not change retrieval algorithms, LLM prompts, database schema, or artifact generation capabilities.

## Completion criteria

- The default sample notebook is visibly presented as example content and can be used immediately.
- A blank notebook offers upload and sample-import paths; success and failure are visible beside the source area.
- Chat shows active source context, never searches all sources after an empty selection, and citations can be opened by keyboard or pointer.
- Studio uses accurate podcast-script wording and shows clear disabled, progress, success, and failure states.
- The workspace has usable narrow-screen behavior, visible keyboard focus, dialog keyboard handling, status announcements, and reduced-motion support.
