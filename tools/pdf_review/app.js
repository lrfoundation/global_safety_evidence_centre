// PDF Review — frontend (GitHub Pages + Cloudflare Worker)

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const CFG = window.PDF_REVIEW_CONFIG || {};
const WORKER_URL = (CFG.WORKER_URL || '').replace(/\/$/, '');

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DOC_ID = params.get('doc');
const ADMIN_TOKEN = params.get('admin');

// ====================================================
// Router
// ====================================================
if (!DOC_ID) {
    $('index-page').style.display = 'block';
    initIndex();
} else {
    $('review-page').style.display = 'block';
    initReview();
}

// ====================================================
// Index page — list all docs from manifest.json
// ====================================================
// Index page — list all docs from manifest.json
// ====================================================
async function initIndex() {
    try {
        const res = await fetch('docs/manifest.json?t=' + Date.now());
        if (!res.ok) throw new Error('Could not load manifest.json');
        const data = await res.json();

        const docs = data.docs || [];

        // Hero stat callouts
        $('statDocs').textContent = docs.length || '—';
        if (docs.length > 0) {
            const latestDoc = [...docs].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0];
            $('statLatest').textContent = formatStatDate(latestDoc.created_at);
        } else {
            $('statLatest').textContent = '—';
        }

        if (docs.length === 0) {
            $('docs-empty').style.display = 'block';
            return;
        }

        // Most recently added on top
        docs.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

        const list = $('docs-list');
        list.innerHTML = docs.map(d => `
            <a class="doc-card" href="?doc=${encodeURIComponent(d.doc_id)}">
                <h3 class="doc-card-title">${escapeHtml(d.title)}</h3>
                <p class="doc-card-meta">Added ${formatDate(d.created_at)}</p>
            </a>
        `).join('');
    } catch (err) {
        $('docs-error').textContent = err.message;
        $('docs-error').style.display = 'block';
    }
}

// ====================================================
// Review page
// ====================================================
async function initReview() {
    if (!WORKER_URL || WORKER_URL === 'PASTE_WORKER_URL_HERE') {
        $('pdf-loading').textContent = 'Worker URL not configured. Edit config.js and set WORKER_URL.';
        return;
    }

    const state = {
        docMeta: null,
        pdfDoc: null,
        zoom: 1.0,
        annotations: [],
        activeAnnotationId: null,
        filter: 'open',
        userName: localStorage.getItem('pdfreview_name') || '',
    };

    const pagesEl = $('pdf-pages');
    const loadingEl = $('pdf-loading');
    const commentsList = $('comments-list');
    const commentsEmpty = $('comments-empty');

    // ----- user chip -----
    function renderUserChip() {
        $('user-chip-name').textContent = state.userName || 'Not signed in';
    }
    renderUserChip();
    $('change-name-btn').addEventListener('click', () => promptForName());

    function promptForName() {
        return new Promise((resolve) => {
            const modal = $('name-modal');
            const input = $('name-input');
            input.value = state.userName || '';
            modal.style.display = 'flex';
            setTimeout(() => input.focus(), 50);

            const close = (name) => { modal.style.display = 'none'; resolve(name); };
            $('name-save').onclick = () => {
                const v = input.value.trim();
                if (!v) return;
                state.userName = v;
                try { localStorage.setItem('pdfreview_name', v); } catch (_) {}
                renderUserChip();
                close(v);
            };
            $('name-cancel').onclick = () => close(null);
            input.onkeydown = (e) => {
                if (e.key === 'Enter') $('name-save').click();
                if (e.key === 'Escape') $('name-cancel').click();
            };
        });
    }

    async function ensureName() {
        if (state.userName) return state.userName;
        return await promptForName();
    }

    // ----- zoom -----
    $('zoom-in').addEventListener('click', () => setZoom(state.zoom + 0.2));
    $('zoom-out').addEventListener('click', () => setZoom(Math.max(0.4, state.zoom - 0.2)));

    async function setZoom(z) {
        state.zoom = Math.round(z * 10) / 10;
        $('zoom-label').textContent = Math.round(state.zoom * 100) + '%';
        if (state.pdfDoc) await renderAllPages();
    }

    // ----- filter buttons -----
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('is-active'));
            btn.classList.add('is-active');
            state.filter = btn.dataset.filter;
            renderPins();
            renderComments();
        });
    });

    // ----- admin bar -----
    if (ADMIN_TOKEN) $('admin-bar').style.display = 'block';

    // ----- 1: Load doc meta from repo -----
    try {
        // Doc folder is at docs/<doc_id>/. Meta is meta.json there.
        const metaRes = await fetch(`docs/${DOC_ID}/meta.json?t=` + Date.now());
        if (!metaRes.ok) throw new Error('Document not found');
        state.docMeta = await metaRes.json();
        $('doc-title').textContent = state.docMeta.title || 'Untitled';
        $('doc-meta').textContent = 'Added ' + formatDate(state.docMeta.created_at);
        document.title = (state.docMeta.title || 'Document') + ' — PDF Review';
    } catch (err) {
        loadingEl.textContent = 'Error: ' + err.message;
        return;
    }

    // ----- 2: Fetch annotations from Worker (in parallel with PDF load) -----
    const annoP = fetchAnnotations().catch(err => {
        toast('Could not load comments: ' + err.message);
        return [];
    });

    // ----- 3: Render PDF -----
    try {
        const pdfUrl = `docs/${DOC_ID}/document.pdf?v=${state.docMeta.file_size}`;
        state.pdfDoc = await pdfjsLib.getDocument(pdfUrl).promise;
        loadingEl.style.display = 'none';
        await renderAllPages();
    } catch (err) {
        loadingEl.textContent = 'Could not load PDF: ' + err.message;
        return;
    }

    // ----- 4: Annotations arrive (or were already there) -----
    state.annotations = await annoP;
    renderPins();
    renderComments();

    // ====================================================
    // Worker API calls
    // ====================================================

    async function fetchAnnotations() {
        const r = await fetch(`${WORKER_URL}/annotations?doc_id=${encodeURIComponent(DOC_ID)}`);
        if (!r.ok) throw new Error('Failed to fetch annotations');
        const d = await r.json();
        return d.annotations || [];
    }

    async function postAnnotation(page, x_pct, y_pct, name, text) {
        const r = await fetch(`${WORKER_URL}/annotations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ doc_id: DOC_ID, page, x_pct, y_pct, author_name: name, body: text }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Save failed');
        return d;
    }

    async function postReply(annoId, name, text) {
        const r = await fetch(`${WORKER_URL}/annotations/${annoId}/comments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ doc_id: DOC_ID, author_name: name, body: text }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Reply failed');
        return d;
    }

    async function patchResolved(annoId) {
        const r = await fetch(`${WORKER_URL}/annotations/${annoId}/resolved`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ doc_id: DOC_ID }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Update failed');
        return d;
    }

    async function deleteAnno(annoId) {
        if (!ADMIN_TOKEN) throw new Error('Admin token required');
        const url = `${WORKER_URL}/annotations/${annoId}?doc_id=${encodeURIComponent(DOC_ID)}&admin_token=${encodeURIComponent(ADMIN_TOKEN)}`;
        const r = await fetch(url, { method: 'DELETE' });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Delete failed');
        return d;
    }

    // ====================================================
    // PDF rendering
    // ====================================================

    async function renderAllPages() {
        pagesEl.innerHTML = '';
        for (let i = 1; i <= state.pdfDoc.numPages; i++) {
            const page = await state.pdfDoc.getPage(i);
            const viewport = page.getViewport({ scale: state.zoom });

            const container = document.createElement('div');
            const wrap = document.createElement('div');
            wrap.className = 'page-wrap';
            wrap.dataset.page = i;

            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            wrap.appendChild(canvas);

            const label = document.createElement('div');
            label.className = 'page-label';
            label.textContent = 'Page ' + i + ' / ' + state.pdfDoc.numPages;

            container.appendChild(wrap);
            container.appendChild(label);
            pagesEl.appendChild(container);

            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

            wrap.addEventListener('click', async (e) => {
                if (e.target.closest('.pin') || e.target.closest('.pin-popover')) return;
                const rect = wrap.getBoundingClientRect();
                const x_pct = (e.clientX - rect.left) / rect.width;
                const y_pct = (e.clientY - rect.top) / rect.height;
                await openNewPinDraft(i, x_pct, y_pct, wrap);
            });
        }
        renderPins();
    }

    async function openNewPinDraft(page, x_pct, y_pct, wrap) {
        const name = await ensureName();
        if (!name) return;
        closeDraft();

        const pop = document.createElement('div');
        pop.className = 'pin-popover';
        pop.id = 'draft-popover';
        pop.style.left = (x_pct * 100) + '%';
        pop.style.top = (y_pct * 100) + '%';
        pop.innerHTML = `
            <textarea id="draft-text" placeholder="Add a comment…"></textarea>
            <div class="pin-popover-actions">
                <button type="button" class="cancel" id="draft-cancel">Cancel</button>
                <button type="button" class="save" id="draft-save">Comment</button>
            </div>
        `;
        wrap.appendChild(pop);
        setTimeout(() => $('draft-text').focus(), 50);

        $('draft-cancel').addEventListener('click', closeDraft);
        $('draft-save').addEventListener('click', async () => {
            const text = $('draft-text').value.trim();
            if (!text) return;
            $('draft-save').disabled = true;
            try {
                const data = await postAnnotation(page, x_pct, y_pct, name, text);
                state.annotations.push({
                    id: data.annotation_id,
                    page, x_pct, y_pct,
                    resolved: false,
                    comments: [{
                        id: data.comment_id,
                        author_name: name,
                        body: text,
                        created_at: new Date().toISOString(),
                    }],
                });
                closeDraft();
                state.activeAnnotationId = data.annotation_id;
                renderPins();
                renderComments();
            } catch (err) {
                toast('Error: ' + err.message);
                $('draft-save').disabled = false;
            }
        });
    }

    function closeDraft() {
        const d = $('draft-popover');
        if (d) d.remove();
    }

    // ====================================================
    // Render pins and comments
    // ====================================================

    function renderPins() {
        document.querySelectorAll('.pin').forEach(p => p.remove());
        state.annotations.forEach((a, idx) => {
            if (state.filter === 'open' && a.resolved) return;
            if (state.filter === 'resolved' && !a.resolved) return;

            const wrap = document.querySelector(`.page-wrap[data-page="${a.page}"]`);
            if (!wrap) return;
            const pin = document.createElement('div');
            pin.className = 'pin'
                + (a.resolved ? ' resolved' : '')
                + (state.activeAnnotationId === a.id ? ' active' : '');
            pin.style.left = (a.x_pct * 100) + '%';
            pin.style.top = (a.y_pct * 100) + '%';
            pin.innerHTML = `<span class="pin-num">${idx + 1}</span>`;
            pin.addEventListener('click', (e) => {
                e.stopPropagation();
                state.activeAnnotationId = a.id;
                renderPins();
                renderComments();
                const card = document.querySelector(`[data-anno-id="${a.id}"]`);
                if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            });
            wrap.appendChild(pin);
        });
    }

    function renderComments() {
        const visible = state.annotations.filter(a => {
            if (state.filter === 'open') return !a.resolved;
            if (state.filter === 'resolved') return a.resolved;
            return true;
        });
        $('comment-count').textContent = visible.length;

        if (state.annotations.length === 0) {
            commentsEmpty.style.display = 'block';
            commentsList.innerHTML = '';
            return;
        }
        commentsEmpty.style.display = 'none';

        commentsList.innerHTML = visible.map(a => {
            const realIdx = state.annotations.indexOf(a) + 1;
            const root = a.comments[0];
            const replies = a.comments.slice(1);
            const active = state.activeAnnotationId === a.id;
            return `
                <div class="comment-card ${active ? 'active' : ''} ${a.resolved ? 'resolved' : ''}" data-anno-id="${a.id}">
                    <div class="comment-head">
                        <span class="avatar">${initials(root.author_name)}</span>
                        <span class="comment-author">${escapeHtml(root.author_name)}</span>
                        <span class="comment-meta-page">p${a.page} · #${realIdx}</span>
                    </div>
                    <div class="comment-body">${escapeHtml(root.body)}</div>
                    ${replies.length ? `
                        <div class="reply-thread">
                            ${replies.map(r => `
                                <div class="reply-item">
                                    <div class="reply-head">
                                        <span class="avatar">${initials(r.author_name)}</span>
                                        <span class="comment-author">${escapeHtml(r.author_name)}</span>
                                    </div>
                                    <div class="reply-body">${escapeHtml(r.body)}</div>
                                </div>
                            `).join('')}
                        </div>
                    ` : ''}
                    ${active ? `
                        <div class="card-actions">
                            <div class="reply-input-row">
                                <input type="text" placeholder="Reply…" id="reply-input-${a.id}">
                                <button data-reply-btn="${a.id}">Reply</button>
                            </div>
                            <div class="card-buttons">
                                <button data-resolve="${a.id}">${a.resolved ? 'Reopen' : 'Mark resolved'}</button>
                                ${ADMIN_TOKEN ? `<button class="admin-delete" data-delete="${a.id}">Delete</button>` : ''}
                            </div>
                        </div>
                    ` : ''}
                </div>
            `;
        }).join('');

        // Wire up
        commentsList.querySelectorAll('.comment-card').forEach(card => {
            card.addEventListener('click', (e) => {
                if (e.target.closest('button') || e.target.closest('input')) return;
                state.activeAnnotationId = parseInt(card.dataset.annoId);
                renderPins();
                renderComments();
            });
        });
        commentsList.querySelectorAll('[data-reply-btn]').forEach(btn => {
            btn.addEventListener('click', () => addReplyAction(parseInt(btn.dataset.replyBtn)));
        });
        commentsList.querySelectorAll('input[id^="reply-input-"]').forEach(input => {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    const id = parseInt(input.id.replace('reply-input-', ''));
                    addReplyAction(id);
                }
            });
        });
        commentsList.querySelectorAll('[data-resolve]').forEach(btn => {
            btn.addEventListener('click', () => toggleResolvedAction(parseInt(btn.dataset.resolve)));
        });
        commentsList.querySelectorAll('[data-delete]').forEach(btn => {
            btn.addEventListener('click', () => deleteAction(parseInt(btn.dataset.delete)));
        });
    }

    async function addReplyAction(anno_id) {
        const name = await ensureName();
        if (!name) return;
        const input = $('reply-input-' + anno_id);
        const text = input.value.trim();
        if (!text) return;
        input.disabled = true;
        try {
            const data = await postReply(anno_id, name, text);
            const a = state.annotations.find(x => x.id === anno_id);
            a.comments.push({
                id: data.comment_id,
                author_name: name,
                body: text,
                created_at: new Date().toISOString(),
            });
            renderComments();
        } catch (err) {
            toast('Error: ' + err.message);
        }
        input.disabled = false;
    }

    async function toggleResolvedAction(anno_id) {
        try {
            const data = await patchResolved(anno_id);
            const a = state.annotations.find(x => x.id === anno_id);
            a.resolved = data.resolved;
            renderPins();
            renderComments();
        } catch (err) {
            toast('Error: ' + err.message);
        }
    }

    async function deleteAction(anno_id) {
        if (!confirm('Delete this comment thread? This cannot be undone.')) return;
        try {
            await deleteAnno(anno_id);
            state.annotations = state.annotations.filter(x => x.id !== anno_id);
            if (state.activeAnnotationId === anno_id) state.activeAnnotationId = null;
            renderPins();
            renderComments();
        } catch (err) {
            toast('Error: ' + err.message);
        }
    }
}

// ====================================================
// Helpers
// ====================================================
function initials(name) {
    return (name || '?').trim().split(/\s+/).slice(0, 2).map(p => p[0] || '').join('').toUpperCase();
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
}

function formatDate(iso) {
    if (!iso) return '—';
    try {
        const d = new Date(iso);
        return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (_) { return iso; }
}

// Compact format for the hero stat callout (e.g. "27 May")
function formatStatDate(iso) {
    if (!iso) return '—';
    try {
        const d = new Date(iso);
        return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    } catch (_) { return iso; }
}

function toast(msg) {
    document.querySelectorAll('.toast').forEach(t => t.remove());
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
}
