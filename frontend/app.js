// ===== ResearchLM - Advanced RAG Frontend =====

const API_BASE = '/api';

// ===== State =====
const state = {
    notebooks: [],
    activeNotebookId: null,
    sources: [],
    activeSources: new Set(),
    messages: [],
    artifacts: [],
    uploadJobs: [],
    uploadSequence: 0,
    uploadQueueRunning: false,
    studioGenerating: new Set(),
    studioActionStatuses: new Map(),
    notebookSelectionSequence: 0,
    isLoading: false,
    studioOpen: false,
};

// ===== DOM Refs =====
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const modalOpeners = new Map();
const mobileSidebarMedia = window.matchMedia('(max-width: 760px)');

const dom = {
    sidebar: $('#sidebar'),
    sidebarBackdrop: $('#sidebarBackdrop'),
    sidebarToggle: $('#btnToggleSidebar'),
    main: $('.main-content'),
    notebooksList: $('#notebooksList'),
    sourcesList: $('#sourcesList'),
    uploadStatusList: $('#uploadStatusList'),
    notebookTitle: $('#notebookTitle'),
    chatMessages: $('#chatMessages'),
    chatStatus: $('#chatStatus'),
    chatInput: $('#chatInput'),
    btnSend: $('#btnSend'),
    welcomeState: $('#welcomeState'),
    welcomeTitle: $('#welcomeTitle'),
    welcomeCopy: $('#welcomeCopy'),
    welcomeActions: $('#welcomeActions'),
    welcomeSuggestions: $('#welcomeSuggestions'),
    studioPanel: $('#studioPanel'),
    studioSelectionHint: $('#studioSelectionHint'),
    artifactsList: $('#artifactsList'),
    statusIndicator: $('#statusIndicator'),
    activeSourceSummary: $('#activeSourceSummary'),
    sourceSelectionHint: $('#sourceSelectionHint'),
    chatGroundingHint: $('#chatGroundingHint'),
    loadingOverlay: $('#loadingOverlay'),
    loadingText: $('#loadingText'),
    toastContainer: $('#toastContainer'),
    fileInput: $('#fileInput'),
};

// ===== Init =====
document.addEventListener('DOMContentLoaded', async () => {
    setupEventListeners();
    await checkHealth();
    await loadNotebooks();
});

// ===== API Helpers =====
async function api(path, options = {}) {
    const url = `${API_BASE}${path}`;
    const config = {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    };
    if (config.body && typeof config.body === 'object' && !(config.body instanceof FormData)) {
        config.body = JSON.stringify(config.body);
    }
    if (config.body instanceof FormData) {
        delete config.headers['Content-Type'];
    }
    const resp = await fetch(url, config);
    if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`API Error (${resp.status}): ${errText}`);
    }
    return resp.json();
}

// ===== Health Check =====
async function checkHealth() {
    try {
        const health = await api('/health');
        const dot = dom.statusIndicator.querySelector('.status-dot');
        const label = dom.statusIndicator.querySelector('span');
        dot.className = 'status-dot connected';
        label.textContent = health.go_processor === 'http_active' ? 'All systems online' : 'Ready (Go CLI mode)';
        showToast('Connected to backend', 'success');
    } catch {
        const dot = dom.statusIndicator.querySelector('.status-dot');
        const label = dom.statusIndicator.querySelector('span');
        dot.className = 'status-dot error';
        label.textContent = 'Backend offline';
        showToast('Cannot reach backend. Start it with: uvicorn backend.app.main:app --port 8000', 'error');
    }
}

// ===== Notebooks =====
async function loadNotebooks() {
    try {
        state.notebooks = await api('/notebooks');
        renderNotebooks();
        if (state.notebooks.length > 0 && !state.activeNotebookId) {
            await selectNotebook(state.notebooks[0].id);
        } else if (state.notebooks.length === 0) {
            state.notebookSelectionSequence += 1;
            state.activeNotebookId = null;
            state.sources = [];
            state.activeSources.clear();
            state.messages = [];
            state.artifacts = [];
            dom.notebookTitle.textContent = 'Your notebooks';
            renderSources();
            renderWelcomeState();
            renderMessages();
            renderArtifacts();
            renderStudioStatuses();
        }
    } catch (e) {
        console.error('Load notebooks failed:', e);
    }
}

function renderNotebooks() {
    dom.notebooksList.innerHTML = state.notebooks.map(nb => {
        const sourceCount = nb.source_count || 0;
        const exampleLabel = nb.id === 'default-research' ? 'Example · ' : '';
        return `
        <button class="notebook-item ${nb.id === state.activeNotebookId ? 'active' : ''}" type="button" data-id="${escapeHtml(String(nb.id))}" aria-current="${nb.id === state.activeNotebookId ? 'page' : 'false'}">
            <span class="nb-icon" aria-hidden="true">📓</span>
            <span class="nb-info">
                <span class="nb-name">${escapeHtml(nb.title)}</span>
                <span class="nb-meta">${exampleLabel}${sourceCount} source${sourceCount === 1 ? '' : 's'} · ${nb.message_count || 0} messages</span>
            </span>
        </button>
    `;
    }).join('');

    dom.notebooksList.querySelectorAll('.notebook-item').forEach(el => {
        el.addEventListener('click', () => {
            selectNotebook(el.dataset.id);
            closeMobileSidebar();
        });
    });
}

async function selectNotebook(notebookId) {
    const selectionSequence = ++state.notebookSelectionSequence;
    state.activeNotebookId = notebookId;
    state.sources = [];
    state.activeSources.clear();
    state.messages = [];
    state.artifacts = [];
    dom.chatStatus.textContent = '';
    dom.notebookTitle.textContent = 'Loading notebook…';
    renderStudioStatuses();
    renderNotebooks();
    renderSources();
    renderWelcomeState();
    renderMessages();
    renderArtifacts();
    renderUploadJobs();

    try {
        const nb = await api(`/notebooks/${notebookId}`);
        if (selectionSequence !== state.notebookSelectionSequence || state.activeNotebookId !== notebookId) return;
        dom.notebookTitle.textContent = nb.title;
        state.sources = nb.sources || [];
        state.activeSources = new Set(state.sources.map(s => s.id));
        renderSources();
        renderWelcomeState();
        await loadMessages(notebookId);
        await loadArtifacts(notebookId);
    } catch (e) {
        if (selectionSequence !== state.notebookSelectionSequence || state.activeNotebookId !== notebookId) return;
        console.error('Select notebook error:', e);
        showToast('Failed to load notebook', 'error');
    }
}

function renderWelcomeState() {
    const isExampleNotebook = state.activeNotebookId === 'default-research';
    const hasExampleSource = state.sources.some(source => source.filename?.toLowerCase() === 'attention.pdf');

    if (!state.activeNotebookId) {
        dom.welcomeTitle.textContent = 'Start your first notebook';
        dom.welcomeCopy.textContent = 'Create a notebook to organize sources and ask questions with citations.';
        dom.welcomeActions.innerHTML = '<button class="btn-primary" data-welcome-action="create-notebook">Create notebook</button>';
        dom.welcomeSuggestions.innerHTML = '';
        return;
    }

    if (state.sources.length === 0) {
        dom.welcomeTitle.textContent = 'Add a source to begin';
        dom.welcomeCopy.textContent = 'Upload a document of your own, or explore the example paper first.';
        dom.welcomeActions.innerHTML = `
            <button class="btn-primary" data-welcome-action="upload-source">Upload a document</button>
            <button class="btn-outline" data-welcome-action="import-sample">Try a sample</button>`;
        dom.welcomeSuggestions.innerHTML = '';
        return;
    }

    dom.welcomeActions.innerHTML = '';
    if (isExampleNotebook && hasExampleSource) {
        dom.welcomeTitle.textContent = 'Your example notebook is ready';
        dom.welcomeCopy.textContent = 'The Transformer paper is already here. Try a question to see how answers connect to their sources.';
        dom.welcomeSuggestions.innerHTML = `
            <button class="suggestion-chip" data-query="How does attention replace recurrence?">How attention works</button>
            <button class="suggestion-chip" data-query="What are the key components of the Transformer?">Key components</button>
            <button class="suggestion-chip" data-query="How does the paper evaluate the Transformer model?">Evaluation approach</button>`;
        return;
    }

    dom.welcomeTitle.textContent = 'Ask about your sources';
    dom.welcomeCopy.textContent = 'Choose a question starter, or write your own. Answers include citations to the source text.';
    dom.welcomeSuggestions.innerHTML = `
        <button class="suggestion-chip" data-query="What are the key findings in my sources?">Key findings</button>
        <button class="suggestion-chip" data-query="Summarize the main concepts discussed in the documents">Summarize concepts</button>
        <button class="suggestion-chip" data-query="What methodology or approach is described?">Methodology</button>
        <button class="suggestion-chip" data-query="What are the limitations mentioned?">Limitations</button>`;
}

async function importSampleSource() {
    if (!state.activeNotebookId) return;

    const button = dom.welcomeActions.querySelector('[data-welcome-action="import-sample"]');
    if (button) {
        button.disabled = true;
        button.textContent = 'Adding sample…';
    }

    try {
        const result = await api(`/notebooks/${state.activeNotebookId}/sources/import-sample`, { method: 'POST' });
        showToast(`Added ${result.filename || 'the sample source'}`, 'success');
        const notebookId = state.activeNotebookId;
        await loadNotebooks();
        await selectNotebook(notebookId);
    } catch (e) {
        showToast(`Could not add the sample: ${e.message}`, 'error');
        if (button) {
            button.disabled = false;
            button.textContent = 'Try a sample';
        }
    }
}

async function createNotebook() {
    const title = $('#newNotebookTitle').value.trim();
    if (!title) return showToast('Please enter a title', 'error');
    const desc = $('#newNotebookDesc').value.trim();

    try {
        showLoading('Creating notebook...');
        const nb = await api('/notebooks', { method: 'POST', body: { title, description: desc } });
        hideLoading();
        closeModal('newNotebookModal');
        showToast(`Created "${nb.title}"`, 'success');
        await loadNotebooks();
        await selectNotebook(nb.id);
        const nextAction = dom.welcomeActions.querySelector('[data-welcome-action]');
        if (nextAction) nextAction.focus();
        else dom.chatInput.focus();
    } catch (e) {
        hideLoading();
        showToast('Failed to create notebook', 'error');
    }
}

// ===== Sources =====
function renderSources() {
    if (state.sources.length === 0) {
        dom.sourcesList.innerHTML = `
            <div class="empty-state">
                <p>No sources yet</p>
                <p style="margin-top:4px;font-size:0.72rem;">Upload PDFs, text, or markdown files</p>
            </div>`;
        updateSourceSelectionUI();
        return;
    }

    dom.sourcesList.innerHTML = state.sources.map(src => {
        const ext = (src.file_type || '.pdf').replace('.', '').toUpperCase();
        const iconClass = ext.toLowerCase();
        const checked = state.activeSources.has(src.id);
        const isExampleSource = state.activeNotebookId === 'default-research'
            && src.filename?.toLowerCase() === 'attention.pdf';
        return `
        <div class="source-item">
                <input type="checkbox" class="source-checkbox" ${checked ? 'checked' : ''} data-source-id="${escapeHtml(String(src.id))}" aria-label="Include ${escapeHtml(src.filename)} in questions and Studio items" aria-describedby="activeSourceSummary">
                <button class="source-preview" type="button" data-source-id="${escapeHtml(String(src.id))}" aria-label="Preview ${escapeHtml(src.filename)}">
                    <span class="source-icon ${escapeHtml(iconClass)}" aria-hidden="true">${escapeHtml(ext)}</span>
                    <span class="source-name" title="${escapeHtml(src.filename)}">${escapeHtml(src.filename)}${isExampleSource ? '<span class="source-sample-label">Sample</span>' : ''}</span>
                    <span class="source-chunks">${src.chunk_count || 0} chunks</span>
                </button>
            </div>`;
    }).join('');

    dom.sourcesList.querySelectorAll('.source-checkbox').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const sid = e.target.dataset.sourceId;
            if (e.target.checked) {
                state.activeSources.add(sid);
            } else {
                state.activeSources.delete(sid);
            }
            updateSourceSelectionUI();
        });
        cb.addEventListener('click', (e) => e.stopPropagation());
    });

    dom.sourcesList.querySelectorAll('.source-preview').forEach(el => {
        el.addEventListener('click', () => viewSource(el.dataset.sourceId, el));
    });
    updateSourceSelectionUI();
}

function updateSourceSelectionUI() {
    const activeCount = state.activeSources.size;
    const totalCount = state.sources.length;
    const hasActiveSources = activeCount > 0;

    if (dom.activeSourceSummary) {
        dom.activeSourceSummary.textContent = totalCount === 0
            ? 'No sources added yet'
            : activeCount === totalCount
                ? `${totalCount} source${totalCount === 1 ? '' : 's'} selected`
                : `${activeCount} of ${totalCount} sources selected`;
    }

    dom.sourceSelectionHint?.classList.toggle('hidden', totalCount === 0 || hasActiveSources);
    dom.chatGroundingHint?.classList.toggle('hidden', !hasActiveSources);
    const canSend = Boolean(dom.chatInput.value.trim() && hasActiveSources);
    dom.btnSend.disabled = !canSend;
    dom.btnSend.setAttribute('aria-disabled', String(!canSend || state.isLoading));
    dom.btnSend.setAttribute('aria-busy', String(state.isLoading));
    updateStudioActionAvailability();
}

function updateStudioActionAvailability() {
    const hasActiveSources = state.activeSources.size > 0;
    dom.studioSelectionHint?.classList.toggle('hidden', hasActiveSources);
    $$('.studio-card').forEach(button => {
        const generating = state.studioGenerating.has(studioGenerationKey(state.activeNotebookId, button.dataset.studioType));
        button.disabled = !hasActiveSources || generating;
        button.setAttribute('aria-disabled', String(!hasActiveSources || generating));
        button.setAttribute('aria-busy', String(generating));
    });
}

function setStudioActionStatus(type, message, status = '', notebookId = state.activeNotebookId) {
    const key = studioGenerationKey(notebookId, type);
    state.studioActionStatuses.set(key, { message, status });
    if (notebookId !== state.activeNotebookId) return;
    const statusEl = dom.studioPanel.querySelector(`[data-studio-status="${type}"]`);
    if (!statusEl) return;
    statusEl.className = `studio-card-status ${status}`.trim();
    statusEl.setAttribute('role', status === 'error' ? 'alert' : 'status');
    statusEl.setAttribute('aria-live', status === 'error' ? 'assertive' : 'polite');
    statusEl.textContent = message;
}

function studioGenerationKey(notebookId, type) {
    return JSON.stringify([notebookId, type]);
}

function renderStudioStatuses() {
    $$('.studio-card-status').forEach(statusEl => {
        const entry = state.studioActionStatuses.get(studioGenerationKey(state.activeNotebookId, statusEl.dataset.studioStatus));
        statusEl.className = `studio-card-status ${entry?.status || ''}`.trim();
        statusEl.setAttribute('role', entry?.status === 'error' ? 'alert' : 'status');
        statusEl.setAttribute('aria-live', entry?.status === 'error' ? 'assertive' : 'polite');
        statusEl.textContent = entry?.message || '';
    });
}

async function uploadFiles(files) {
    if (!state.activeNotebookId) return showToast('Select a notebook first', 'error');

    const notebookId = state.activeNotebookId;
    const jobs = [];
    for (const file of Array.from(files)) {
        const fileIdentity = `${file.name}|${file.size}|${file.lastModified}`;
        const alreadyProcessing = state.uploadJobs.some(job =>
            job.notebookId === notebookId && job.fileIdentity === fileIdentity && job.status === 'processing'
        );
        if (alreadyProcessing) continue;

        const job = {
            id: `upload-${++state.uploadSequence}`,
            notebookId,
            file,
            fileIdentity,
            status: 'processing',
            started: false,
            message: 'Waiting to add…',
            chunkCount: 0,
            error: '',
        };
        state.uploadJobs.push(job);
        jobs.push(job);
    }

    if (jobs.length === 0) {
        showToast('That file is already being added.', 'info');
        return;
    }

    renderUploadJobs();
    await processUploadQueue();
}

function renderUploadJobs() {
    const visibleJobs = state.uploadJobs.filter(job => job.notebookId === state.activeNotebookId);
    const focusedJobId = document.activeElement?.closest('.upload-status-item')?.dataset.uploadJob;
    dom.uploadStatusList.innerHTML = visibleJobs.map(job => {
        const detail = job.status === 'added'
            ? `Added · ${job.chunkCount} chunks`
            : job.status === 'failed'
                ? job.error
                : job.message;

        return `
            <div class="upload-status-item ${job.status}" data-upload-job="${job.id}" tabindex="-1" ${job.status === 'failed' ? 'role="alert" aria-live="assertive"' : ''}>
                <span class="upload-status-dot" aria-hidden="true"></span>
                <div class="upload-status-copy">
                    <span class="upload-status-filename" title="${escapeHtml(job.file.name)}">${escapeHtml(job.file.name)}</span>
                    <span class="upload-status-detail">${escapeHtml(detail)}</span>
                </div>
                ${job.status === 'failed' ? `<button class="upload-retry-button" type="button" data-upload-retry="${job.id}" aria-label="Retry adding ${escapeHtml(job.file.name)}">Retry</button>` : ''}
            </div>`;
    }).join('');
    if (focusedJobId) {
        dom.uploadStatusList.querySelector(`[data-upload-job="${focusedJobId}"]`)?.focus({ preventScroll: true });
    }
}

async function processUploadQueue() {
    if (state.uploadQueueRunning) return;
    state.uploadQueueRunning = true;

    try {
        let job;
        while ((job = state.uploadJobs.find(candidate => candidate.status === 'processing' && !candidate.started))) {
            job.started = true;
            job.message = 'Adding to notebook…';
            renderUploadJobs();

            const formData = new FormData();
            formData.append('file', job.file);
            formData.append('chunk_size', '700');
            formData.append('chunk_overlap', '150');

            try {
                const result = await api(`/notebooks/${job.notebookId}/sources/upload`, {
                    method: 'POST',
                    body: formData,
                });
                job.status = 'added';
                job.chunkCount = result.chunk_count || 0;
                job.error = '';
            } catch (e) {
                job.status = 'failed';
                job.error = `Could not add this file: ${e.message}`;
            }

            renderUploadJobs();
            await loadNotebooks();
            if (state.activeNotebookId === job.notebookId) {
                await selectNotebook(job.notebookId);
            }
        }
    } finally {
        state.uploadQueueRunning = false;
    }
}

async function retryUpload(jobId) {
    const job = state.uploadJobs.find(candidate => candidate.id === jobId);
    if (!job || job.status !== 'failed') return;

    job.status = 'processing';
    job.started = false;
    job.message = 'Waiting to retry…';
    job.error = '';
    renderUploadJobs();
    await processUploadQueue();
}

async function viewSource(sourceId, trigger = document.activeElement, citationChunkId = null, citationPage = null) {
    const openingFromMobileDrawer = mobileSidebarMedia.matches && dom.sidebar.classList.contains('mobile-open');
    const focusTrigger = openingFromMobileDrawer ? dom.sidebarToggle : trigger;
    const notebookId = state.activeNotebookId;
    const selectionSequence = state.notebookSelectionSequence;
    try {
        const source = await api(`/sources/${sourceId}`);
        if (notebookId !== state.activeNotebookId || selectionSequence !== state.notebookSelectionSequence) return;
        const modal = $('#sourceViewerModal');
        $('#sourceViewerTitle').textContent = source.filename;
        const body = $('#sourceViewerBody');

        const sourceChunks = source.chunks || [];
        const chunksList = sourceChunks.map((ch, i) => `
            <div class="source-chunk" data-chunk-id="${escapeHtml(String(ch.id || ''))}" data-page-number="${escapeHtml(String(ch.page_number ?? ''))}" style="padding:12px;background:var(--bg-tertiary);border-radius:8px;margin-bottom:8px;">
                <div style="font-size:0.72rem;color:var(--text-tertiary);margin-bottom:4px;">Chunk ${i + 1} · Page ${escapeHtml(String(ch.page_number))} · ${escapeHtml(String(ch.token_count))} tokens</div>
                <div style="font-size:0.82rem;line-height:1.5;color:var(--text-primary);">${escapeHtml(ch.content.substring(0, 400))}${ch.content.length > 400 ? '...' : ''}</div>
            </div>`).join('');

        body.innerHTML = `
            <div style="margin-bottom:16px;">
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                    <div style="padding:10px;background:var(--bg-tertiary);border-radius:8px;">
                        <div style="font-size:0.72rem;color:var(--text-tertiary);">File Type</div>
                        <div style="font-weight:600;">${escapeHtml(String(source.file_type || 'Unknown'))}</div>
                    </div>
                    <div style="padding:10px;background:var(--bg-tertiary);border-radius:8px;">
                        <div style="font-size:0.72rem;color:var(--text-tertiary);">Pages</div>
                        <div style="font-weight:600;">${escapeHtml(String(source.page_count ?? '—'))}</div>
                    </div>
                    <div style="padding:10px;background:var(--bg-tertiary);border-radius:8px;">
                        <div style="font-size:0.72rem;color:var(--text-tertiary);">Chunks</div>
                        <div style="font-weight:600;">${escapeHtml(String(source.chunk_count ?? '—'))}</div>
                    </div>
                    <div style="padding:10px;background:var(--bg-tertiary);border-radius:8px;">
                        <div style="font-size:0.72rem;color:var(--text-tertiary);">Characters</div>
                        <div style="font-weight:600;">${escapeHtml(Number(source.char_count || 0).toLocaleString())}</div>
                    </div>
                </div>
            </div>
            <h3 style="font-size:0.82rem;color:var(--text-tertiary);margin-bottom:10px;">CHUNKS PREVIEW</h3>
            ${chunksList}`;

        if (openingFromMobileDrawer) closeMobileSidebar(false);
        openModal(modal.id, focusTrigger);
        renderMath(body);

        if (citationChunkId || citationPage) {
            const sourceChunkElements = Array.from(body.querySelectorAll('.source-chunk'));
            const targetChunk = sourceChunkElements.find(chunk => chunk.dataset.chunkId === citationChunkId)
                || sourceChunkElements.find(chunk => chunk.dataset.pageNumber === String(citationPage));
            if (targetChunk) {
                targetChunk.classList.add('citation-highlight');
                targetChunk.tabIndex = -1;
                requestAnimationFrame(() => {
                    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
                    targetChunk.scrollIntoView({ behavior, block: 'center' });
                    targetChunk.focus({ preventScroll: true });
                });
            }
        }
    } catch (e) {
        showToast('Failed to load source details', 'error');
    }
}

// ===== Messages & Chat =====
async function loadMessages(notebookId = state.activeNotebookId) {
    if (!notebookId) return;

    try {
        const messages = await api(`/notebooks/${notebookId}/messages`);
        if (notebookId !== state.activeNotebookId) return;
        state.messages = messages;
        renderMessages();
    } catch (e) {
        console.error('Load messages error:', e);
    }
}

function renderMessages() {
    if (state.messages.length === 0) {
        dom.welcomeState.classList.remove('hidden');
        dom.chatMessages.innerHTML = '';
        dom.chatMessages.appendChild(dom.welcomeState);
        return;
    }

    dom.welcomeState.classList.add('hidden');
    dom.chatMessages.innerHTML = state.messages.map(msg => renderMessageBubble(msg)).join('');
    renderMath(dom.chatMessages);
    scrollChatToBottom();
}

function renderMessageBubble(msg) {
    const isUser = msg.role === 'user';

    if (isUser) {
        return `
            <div class="message-row user">
                <div class="message-bubble">${escapeHtml(msg.content)}</div>
                <div class="message-avatar user-avatar">U</div>
            </div>`;
    }

    // Build citations section
    const citations = Array.isArray(msg.citations) ? msg.citations : [];
    const content = renderMarkdownLite(msg.content, citations);
    let citationsHtml = '';
    if (citations.length > 0) {
        citationsHtml = `
            <div class="citations-section">
                ${citations.map(cit => `
                    <button class="citation-ref" type="button" data-citation-source="${escapeHtml(String(cit.source_id))}" data-citation-page="${escapeHtml(String(cit.page_number ?? ''))}" data-citation-chunk="${escapeHtml(String(cit.chunk_id || ''))}" aria-label="Open citation ${escapeHtml(String(cit.citation_num))}: ${escapeHtml(cit.source_name)}, page ${escapeHtml(String(cit.page_number))}">
                        <span class="cit-num" aria-hidden="true">${escapeHtml(String(cit.citation_num))}</span>
                        <span class="cit-meta">
                            <span class="cit-source">${escapeHtml(cit.source_name)} · Page ${escapeHtml(String(cit.page_number))}</span>
                            <span class="cit-excerpt">${escapeHtml(cit.excerpt || '')}</span>
                        </span>
                    </button>`).join('')}
            </div>`;
    }

    return `
        <div class="message-row assistant">
            <div class="message-avatar ai">R</div>
            <div class="message-bubble">
                ${content}
                ${citationsHtml}
            </div>
        </div>`;
}

async function sendMessage(queryText) {
    const query = (queryText || dom.chatInput.value).trim();
    if (!query || state.isLoading) return;
    if (!state.activeNotebookId) return showToast('Select a notebook first', 'error');
    if (state.activeSources.size === 0) {
        updateSourceSelectionUI();
        return;
    }

    const notebookId = state.activeNotebookId;
    const selectionSequence = state.notebookSelectionSequence;

    dom.chatInput.value = '';
    autoResize(dom.chatInput);
    dom.chatInput.focus();

    // Hide welcome state
    dom.welcomeState.classList.add('hidden');

    // Add user message bubble immediately
    const userBubble = `
        <div class="message-row user">
            <div class="message-bubble">${escapeHtml(query)}</div>
            <div class="message-avatar user-avatar">U</div>
        </div>`;
    dom.chatMessages.insertAdjacentHTML('beforeend', userBubble);

    // Add typing indicator
    const typingId = 'typing-' + Date.now();
    const typingHtml = `
        <div class="message-row assistant" id="${typingId}">
            <div class="message-avatar ai">R</div>
            <div class="message-bubble">
                <div class="typing-indicator">
                    <div class="typing-dot"></div>
                    <div class="typing-dot"></div>
                    <div class="typing-dot"></div>
                </div>
            </div>
        </div>`;
    dom.chatMessages.insertAdjacentHTML('beforeend', typingHtml);
    scrollChatToBottom();

    state.isLoading = true;
    dom.chatStatus.textContent = 'Searching your selected sources for an answer.';
    updateSourceSelectionUI();

    try {
        const activeSourceIds = Array.from(state.activeSources);
        const result = await api(`/notebooks/${notebookId}/chat`, {
            method: 'POST',
            body: { query, active_sources: activeSourceIds, top_k: 6 },
        });
        if (state.activeNotebookId !== notebookId) return;
        if (state.notebookSelectionSequence !== selectionSequence) {
            await loadMessages(notebookId);
            dom.chatStatus.textContent = 'Conversation refreshed.';
            return;
        }

        // Remove typing indicator
        const typingEl = document.getElementById(typingId);
        if (typingEl) typingEl.remove();

        // Add assistant response
        const aiMsg = result.message;
        dom.chatMessages.insertAdjacentHTML('beforeend', renderMessageBubble(aiMsg));
        renderMath(dom.chatMessages.lastElementChild);
        const citationCount = aiMsg.citations?.length || 0;
        dom.chatStatus.textContent = citationCount
            ? `Answer ready with ${citationCount} citation${citationCount === 1 ? '' : 's'}.`
            : 'Answer ready.';
        state.messages.push({ role: 'user', content: query });
        state.messages.push(aiMsg);
        scrollChatToBottom();
    } catch (e) {
        const typingEl = document.getElementById(typingId);
        if (typingEl) typingEl.remove();
        if (state.activeNotebookId === notebookId) showToast('Failed to get response: ' + e.message, 'error');
    } finally {
        state.isLoading = false;
        updateSourceSelectionUI();
    }
}

// ===== Studio =====
function toggleStudio() {
    state.studioOpen = !state.studioOpen;
    dom.studioPanel.classList.toggle('hidden', !state.studioOpen);
    $('#btnStudio').setAttribute('aria-expanded', String(state.studioOpen));
    if (state.studioOpen) {
        updateStudioActionAvailability();
        loadArtifacts();
    }
}

async function loadArtifacts(notebookId = state.activeNotebookId) {
    if (!notebookId || notebookId !== state.activeNotebookId) return;
    try {
        const artifacts = await api(`/notebooks/${notebookId}/studio/artifacts`);
        if (notebookId !== state.activeNotebookId) return;
        state.artifacts = artifacts;
        renderArtifacts();
    } catch (e) {
        console.error('Load artifacts error:', e);
    }
}

function renderArtifacts() {
    if (state.artifacts.length === 0) {
        dom.artifactsList.innerHTML = '<div class="empty-state">No artifacts generated yet</div>';
        return;
    }

    const icons = { podcast: '🎙️', study_guide: '📚', briefing_doc: '📋', faq: '❓', note: '📝' };
    dom.artifactsList.innerHTML = state.artifacts.map(art => `
        <button class="artifact-item" type="button" data-id="${escapeHtml(String(art.id))}" data-type="${escapeHtml(art.artifact_type)}" aria-label="Open ${escapeHtml(art.title)}">
            <span class="art-icon ${escapeHtml(art.artifact_type)}" aria-hidden="true">${icons[art.artifact_type] || '📄'}</span>
            <span class="art-name">${escapeHtml(art.title)}</span>
        </button>`).join('');

    dom.artifactsList.querySelectorAll('.artifact-item').forEach(el => {
        el.addEventListener('click', () => viewArtifact(el.dataset.id, el.dataset.type, el));
    });
}

async function generateStudioArtifact(type) {
    if (!state.activeNotebookId) return showToast('Select a notebook first', 'error');
    const notebookId = state.activeNotebookId;
    const notebookTitle = state.notebooks.find(notebook => notebook.id === notebookId)?.title || 'your notebook';
    const generationKey = studioGenerationKey(notebookId, type);
    if (state.activeSources.size === 0 || state.studioGenerating.has(generationKey)) {
        updateStudioActionAvailability();
        return;
    }

    const typeLabels = { podcast: 'Podcast script', 'study-guide': 'Study Guide', 'briefing-doc': 'Briefing document', faq: 'FAQ' };
    const activeSourceIds = Array.from(state.activeSources);
    const actionButton = dom.studioPanel.querySelector(`[data-studio-type="${type}"]`);
    const shouldMoveFocus = document.activeElement === actionButton;
    state.studioGenerating.add(generationKey);
    updateStudioActionAvailability();
    setStudioActionStatus(type, 'Generating…', 'progress', notebookId);
    if (shouldMoveFocus) {
        const nextAction = Array.from($$('.studio-card')).find(button => !button.disabled)
            || $('#btnCloseStudio');
        nextAction.focus();
    }

    try {
        await api(`/notebooks/${notebookId}/studio/${type}`, {
            method: 'POST',
            body: { active_sources: activeSourceIds },
        });
        await loadArtifacts(notebookId);
        const successMessage = `${typeLabels[type]} generated and saved.`;
        setStudioActionStatus(type, successMessage, 'success', notebookId);
        if (state.activeNotebookId !== notebookId) {
            showToast(`${successMessage} It was saved in ${notebookTitle}.`, 'success');
        }
    } catch (e) {
        const errorMessage = `Could not generate: ${e.message}`;
        setStudioActionStatus(type, errorMessage, 'error', notebookId);
        if (state.activeNotebookId !== notebookId) {
            showToast(`${typeLabels[type]} failed in ${notebookTitle}: ${e.message}`, 'error');
        }
    } finally {
        state.studioGenerating.delete(generationKey);
        updateStudioActionAvailability();
    }
}

function viewArtifact(artifactId, artifactType, trigger = document.activeElement) {
    const art = state.artifacts.find(a => a.id === artifactId);
    if (!art) return;

    const modal = $('#artifactModal');
    $('#artifactTitle').textContent = art.title;
    const body = $('#artifactBody');

    if (artifactType === 'podcast') {
        const data = art.content;
        const dialogue = data.dialogue || [];
        body.innerHTML = `
            <div style="margin-bottom:16px;">
                <h3 style="font-size:1.1rem;margin-bottom:4px;">${escapeHtml(data.episode_title || art.title)}</h3>
                <p style="color:var(--text-secondary);font-size:0.85rem;">${escapeHtml(data.summary || '')}</p>
            </div>
            <div class="podcast-dialogue">
                ${dialogue.map(turn => `
                    <div class="podcast-turn ${String(turn.speaker).toLowerCase() === 'morgan' ? 'morgan' : 'alex'}">
                        <div class="podcast-speaker">${escapeHtml(String(turn.speaker || 'Host'))}</div>
                        <div class="podcast-text">${escapeHtml(turn.text)}</div>
                    </div>`).join('')}
            </div>`;
    } else {
        // Study guide, briefing doc, FAQ, notes — render as markdown-lite
        const content = typeof art.content === 'string' ? art.content : (art.content.content || JSON.stringify(art.content, null, 2));
        body.innerHTML = renderMarkdownLite(content);
    }
    renderMath(body);

    openModal(modal.id, trigger);
}

// ===== Event Listeners =====
function setupEventListeners() {
    // Sidebar toggle
    dom.sidebarToggle.addEventListener('click', () => {
        if (mobileSidebarMedia.matches) {
            const isOpen = dom.sidebar.classList.contains('mobile-open');
            if (isOpen) closeMobileSidebar();
            else openMobileSidebar();
            return;
        }
        dom.sidebar.classList.toggle('collapsed');
        syncSidebarViewport();
    });
    dom.sidebarBackdrop.addEventListener('click', () => closeMobileSidebar());
    $('#btnCloseSidebar').addEventListener('click', () => closeMobileSidebar());
    mobileSidebarMedia.addEventListener('change', syncSidebarViewport);
    syncSidebarViewport();

    document.addEventListener('keydown', (event) => {
        const openOverlay = $('.modal-overlay:not(.hidden)');
        if (openOverlay) {
            if (event.key === 'Escape') {
                event.preventDefault();
                closeModal(openOverlay.id);
                return;
            }
            if (event.key === 'Tab') trapDialogFocus(event, openOverlay);
            return;
        }
        if (event.key === 'Escape' && mobileSidebarMedia.matches && dom.sidebar.classList.contains('mobile-open')) {
            event.preventDefault();
            closeMobileSidebar();
        } else if (event.key === 'Tab' && mobileSidebarMedia.matches && dom.sidebar.classList.contains('mobile-open')) {
            trapSidebarFocus(event);
        }
    });

    // Chat input
    dom.chatInput.addEventListener('input', () => {
        autoResize(dom.chatInput);
        updateSourceSelectionUI();
    });

    dom.chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    dom.btnSend.addEventListener('click', () => sendMessage());

    // Welcome actions and suggestions are rendered from the selected notebook state.
    dom.welcomeState.addEventListener('click', (event) => {
        const suggestion = event.target.closest('[data-query]');
        if (suggestion) {
            sendMessage(suggestion.dataset.query);
            return;
        }

        const action = event.target.closest('[data-welcome-action]')?.dataset.welcomeAction;
        if (action === 'create-notebook') {
            openModal('newNotebookModal', event.target.closest('[data-welcome-action]'));
        } else if (action === 'upload-source') {
            dom.fileInput.click();
        } else if (action === 'import-sample') {
            importSampleSource();
        }
    });

    // New Notebook
    $('#btnNewNotebook').addEventListener('click', () => {
        openModal('newNotebookModal', $('#btnNewNotebook'));
    });
    $('#btnCloseNewNotebook').addEventListener('click', () => closeModal('newNotebookModal'));
    $('#btnCreateNotebook').addEventListener('click', createNotebook);
    $('#newNotebookTitle').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') createNotebook();
    });

    // Upload Source
    $('#btnUploadSource').addEventListener('click', () => dom.fileInput.click());
    dom.uploadStatusList.addEventListener('click', (event) => {
        const retryButton = event.target.closest('[data-upload-retry]');
        if (retryButton) retryUpload(retryButton.dataset.uploadRetry);
    });
    dom.fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            uploadFiles(e.target.files);
            e.target.value = '';
        }
    });

    // Studio
    $('#btnStudio').addEventListener('click', toggleStudio);
    $('#btnCloseStudio').addEventListener('click', () => {
        state.studioOpen = false;
        dom.studioPanel.classList.add('hidden');
        $('#btnStudio').setAttribute('aria-expanded', 'false');
        $('#btnStudio').focus();
    });

    // Studio action buttons
    $('#btnPodcast').addEventListener('click', () => generateStudioArtifact('podcast'));
    $('#btnStudyGuide').addEventListener('click', () => generateStudioArtifact('study-guide'));
    $('#btnBriefingDoc').addEventListener('click', () => generateStudioArtifact('briefing-doc'));
    $('#btnFAQ').addEventListener('click', () => generateStudioArtifact('faq'));

    // Modals
    $('#btnCloseSourceViewer').addEventListener('click', () => closeModal('sourceViewerModal'));
    $('#btnCloseArtifact').addEventListener('click', () => closeModal('artifactModal'));

    dom.chatMessages.addEventListener('click', (event) => {
        const citation = event.target.closest('[data-citation-source]');
        if (citation) {
            viewSource(
                citation.dataset.citationSource,
                citation,
                citation.dataset.citationChunk || null,
                citation.dataset.citationPage || null
            );
        }
    });

    // Close modal on overlay click
    $$('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeModal(overlay.id);
        });
    });

    // Drag and drop on sources panel
    const sourcesPanel = $('#sourcesPanel');
    sourcesPanel.addEventListener('dragover', (e) => {
        e.preventDefault();
        sourcesPanel.classList.add('drop-zone-active');
    });
    sourcesPanel.addEventListener('dragleave', () => {
        sourcesPanel.classList.remove('drop-zone-active');
    });
    sourcesPanel.addEventListener('drop', (e) => {
        e.preventDefault();
        sourcesPanel.classList.remove('drop-zone-active');
        if (e.dataTransfer.files.length > 0) {
            uploadFiles(e.dataTransfer.files);
        }
    });
}

// ===== Utilities =====
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderMarkdownLite(text, citations = []) {
    if (!text) return '';
    const references = new Map((Array.isArray(citations) ? citations : [])
        .map(citation => [Number(citation.citation_num), citation])
        .filter(([citationNumber, citation]) => Number.isInteger(citationNumber) && citationNumber > 0 && citation?.source_id));
    const source = normalizeLegacyCitationMarkers(String(text), references)
        .replace(/^[\t ]*[-*+][\t ]*\\[\t ]*$/gm, '')
        .replace(/^[\t ]*\\[\t ]*$/gm, '')
        .replace(/\n{3,}/g, '\n\n');

    if (typeof window.markdownit !== 'function') {
        return `<p>${escapeHtml(source).replace(/\n/g, '<br>')}</p>`;
    }

    const markdown = window.markdownit({ html: false, linkify: true, typographer: false });
    markdown.inline.ruler.before('link', 'researchlm_citation', (state, silent) => {
        const match = /^\[(\d{1,3})\]/.exec(state.src.slice(state.pos));
        if (!match || !references.has(Number(match[1]))) return false;
        if (!silent) {
            const token = state.push('researchlm_citation', '', 0);
            token.content = match[1];
            token.meta = { citation: references.get(Number(match[1])) };
        }
        state.pos += match[0].length;
        return true;
    });
    markdown.renderer.rules.researchlm_citation = (tokens, index) => {
        const token = tokens[index];
        const citation = token.meta.citation;
        const citationNumber = escapeHtml(token.content);
        const sourceId = escapeHtml(String(citation.source_id));
        const sourceName = escapeHtml(String(citation.source_name || 'source'));
        const pageNumber = escapeHtml(String(citation.page_number ?? ''));
        const chunkId = escapeHtml(String(citation.chunk_id || ''));
        return `<button class="citation-marker" type="button" data-citation-source="${sourceId}" data-citation-page="${pageNumber}" data-citation-chunk="${chunkId}" aria-label="Open citation ${citationNumber}: ${sourceName}, page ${pageNumber}" title="${sourceName} · Page ${pageNumber}">${citationNumber}</button>`;
    };

    return markdown.render(source);
}

function normalizeLegacyCitationMarkers(text, references) {
    return text.replace(/\*\*(\d{1,3})\*\*(?=\s*(?:[.!?,;:]|$))/g, (marker, label) => {
        const number = Number(label);
        if (references.has(number)) return `[${number}]`;
        if (label.length > 1 && [...label].every(digit => references.has(Number(digit)))) {
            return [...label].map(digit => `[${digit}]`).join('');
        }
        return marker;
    });
}

function renderMath(element) {
    if (!element || typeof window.renderMathInElement !== 'function') return;
    window.renderMathInElement(element, {
        delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '\\[', right: '\\]', display: true },
            { left: '\\(', right: '\\)', display: false },
            { left: '$', right: '$', display: false },
        ],
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
        throwOnError: false,
        trust: false,
    });
}

function autoResize(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
}

function scrollChatToBottom() {
    requestAnimationFrame(() => {
        dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
    });
}

function openMobileSidebar() {
    dom.sidebar.classList.add('mobile-open');
    dom.sidebar.inert = false;
    dom.sidebar.setAttribute('aria-hidden', 'false');
    dom.main.inert = true;
    dom.sidebarBackdrop.classList.remove('hidden');
    dom.sidebarToggle.setAttribute('aria-expanded', 'true');
    const target = dom.sidebar.querySelector('.notebook-item.active') || $('#btnNewNotebook');
    target?.focus();
}

function closeMobileSidebar(restoreFocus = true) {
    if (!mobileSidebarMedia.matches) return;
    dom.sidebar.classList.remove('mobile-open');
    dom.sidebar.inert = true;
    dom.sidebar.setAttribute('aria-hidden', 'true');
    dom.main.inert = false;
    dom.sidebarBackdrop.classList.add('hidden');
    dom.sidebarToggle.setAttribute('aria-expanded', 'false');
    if (restoreFocus) dom.sidebarToggle.focus();
}

function syncSidebarViewport() {
    dom.sidebar.classList.remove('mobile-open');
    dom.sidebarBackdrop.classList.add('hidden');
    if (mobileSidebarMedia.matches) {
        dom.sidebar.classList.remove('collapsed');
        dom.sidebar.inert = true;
        dom.sidebar.setAttribute('aria-hidden', 'true');
        dom.main.inert = false;
        dom.sidebarToggle.setAttribute('aria-expanded', 'false');
    } else {
        const collapsed = dom.sidebar.classList.contains('collapsed');
        dom.sidebar.inert = collapsed;
        dom.sidebar.setAttribute('aria-hidden', String(collapsed));
        dom.main.inert = false;
        dom.sidebarToggle.setAttribute('aria-expanded', String(!dom.sidebar.classList.contains('collapsed')));
    }
}

function openModal(modalId, trigger = document.activeElement) {
    const overlay = document.getElementById(modalId);
    const dialog = overlay?.querySelector('[role="dialog"]');
    if (!overlay || !dialog) return;

    modalOpeners.set(modalId, trigger instanceof HTMLElement ? trigger : null);
    overlay.classList.remove('hidden');
    const firstFocusable = dialog.querySelector('[data-dialog-initial-focus]')
        || dialog.querySelector('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])');
    (firstFocusable || dialog).focus();
}

function trapSidebarFocus(event) {
    const focusable = Array.from(dom.sidebar.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'))
        .filter(element => element.getClientRects().length > 0);
    if (focusable.length === 0) {
        event.preventDefault();
        dom.sidebar.focus();
        return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !dom.sidebar.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
    }
}

function closeModal(modalId) {
    const overlay = document.getElementById(modalId);
    if (!overlay || overlay.classList.contains('hidden')) return;
    overlay.classList.add('hidden');
    const trigger = modalOpeners.get(modalId);
    modalOpeners.delete(modalId);
    if (trigger?.isConnected && !trigger.disabled && !trigger.closest('[inert]')) trigger.focus();
    else dom.chatInput.focus();
}

function trapDialogFocus(event, overlay) {
    const dialog = overlay.querySelector('[role="dialog"]');
    const focusable = Array.from(dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'))
        .filter(element => element.getClientRects().length > 0);
    if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
    }
}

function showLoading(text = 'Processing...') {
    dom.loadingText.textContent = text;
    dom.loadingOverlay.classList.remove('hidden');
}

function hideLoading() {
    dom.loadingOverlay.classList.add('hidden');
}

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
    toast.textContent = message;
    dom.toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}
