// PDF Review — Cloudflare Worker
// REST API for annotations and comments backed by a D1 SQLite database.
//
// Routes:
//   POST   /docs                                  Register a new document (called once when adding a PDF)
//   GET    /annotations?doc_id=...                List annotations for a doc
//   POST   /annotations                           Create annotation (+ first comment)
//   POST   /annotations/:id/comments              Reply
//   PATCH  /annotations/:id/resolved              Toggle resolved
//   DELETE /annotations/:id?doc_id=...&admin_token=...   Admin delete
//
// Admin tokens are hashed (SHA-256) before storage in the documents table.
// The plaintext token is only ever in the meta.json file in the repo and the
// admin URL. The Worker verifies submitted tokens by re-hashing and comparing.

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
};

const DOC_ID_PATTERN = /^[a-z0-9]{16,32}$/i;
const ADMIN_TOKEN_PATTERN = /^[a-z0-9]{32,64}$/i;

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        const url = new URL(request.url);
        const path = url.pathname;

        try {
            if (path === '/docs' && request.method === 'POST') {
                return await registerDoc(request, env);
            }

            if (path === '/annotations' && request.method === 'GET') {
                return await listAnnotations(url, env);
            }

            if (path === '/annotations' && request.method === 'POST') {
                return await createAnnotation(request, env);
            }

            let match = path.match(/^\/annotations\/(\d+)\/comments$/);
            if (match && request.method === 'POST') {
                return await addComment(parseInt(match[1]), request, env);
            }

            match = path.match(/^\/annotations\/(\d+)\/resolved$/);
            if (match && request.method === 'PATCH') {
                return await toggleResolved(parseInt(match[1]), request, env);
            }

            match = path.match(/^\/annotations\/(\d+)$/);
            if (match && request.method === 'DELETE') {
                return await deleteAnnotation(parseInt(match[1]), url, env);
            }

            return jsonResponse({ error: 'Not found' }, 404);
        } catch (err) {
            console.error(err);
            return jsonResponse({ error: 'Server error' }, 500);
        }
    },
};

// ============================================================
// Route handlers
// ============================================================

async function registerDoc(request, env) {
    const body = await readJson(request);
    const docId = body.doc_id;
    const adminToken = body.admin_token;

    if (!docId || !DOC_ID_PATTERN.test(docId)) return jsonResponse({ error: 'Invalid doc_id' }, 400);
    if (!adminToken || !ADMIN_TOKEN_PATTERN.test(adminToken)) return jsonResponse({ error: 'Invalid admin_token' }, 400);

    // Reject duplicate registration to keep tokens stable. Once a doc is
    // registered, it stays registered.
    const existing = await env.DB.prepare('SELECT 1 FROM documents WHERE doc_id = ?').bind(docId).first();
    if (existing) return jsonResponse({ error: 'Document already registered' }, 409);

    const hash = await sha256(adminToken);
    await env.DB.prepare(
        'INSERT INTO documents (doc_id, admin_token_hash) VALUES (?, ?)'
    ).bind(docId, hash).run();

    return jsonResponse({ ok: true, doc_id: docId });
}

async function listAnnotations(url, env) {
    const docId = url.searchParams.get('doc_id');
    if (!docId || !DOC_ID_PATTERN.test(docId)) return jsonResponse({ error: 'Invalid doc_id' }, 400);

    const annos = await env.DB.prepare(
        'SELECT id, page, x_pct, y_pct, resolved, created_at FROM annotations WHERE doc_id = ? ORDER BY id ASC'
    ).bind(docId).all();

    if (!annos.results.length) return jsonResponse({ annotations: [] });

    const ids = annos.results.map(a => a.id);
    const placeholders = ids.map(() => '?').join(',');
    const comments = await env.DB.prepare(
        `SELECT id, annotation_id, author_name, body, created_at
         FROM comments WHERE annotation_id IN (${placeholders}) ORDER BY id ASC`
    ).bind(...ids).all();

    const byAnno = {};
    for (const c of comments.results) {
        if (!byAnno[c.annotation_id]) byAnno[c.annotation_id] = [];
        byAnno[c.annotation_id].push({
            id: c.id,
            author_name: c.author_name,
            body: c.body,
            created_at: c.created_at,
        });
    }

    const annotations = annos.results.map(a => ({
        id: a.id,
        page: a.page,
        x_pct: a.x_pct,
        y_pct: a.y_pct,
        resolved: !!a.resolved,
        comments: byAnno[a.id] || [],
    }));

    return jsonResponse({ annotations });
}

async function createAnnotation(request, env) {
    const body = await readJson(request);
    const docId = body.doc_id;
    const page = parseInt(body.page);
    const xPct = parseFloat(body.x_pct);
    const yPct = parseFloat(body.y_pct);
    const author = (body.author_name || '').trim();
    const text = (body.body || '').trim();

    if (!docId || !DOC_ID_PATTERN.test(docId)) return jsonResponse({ error: 'Invalid doc_id' }, 400);
    if (!Number.isInteger(page) || page < 1) return jsonResponse({ error: 'Invalid page' }, 400);
    if (!(xPct >= 0 && xPct <= 1) || !(yPct >= 0 && yPct <= 1)) return jsonResponse({ error: 'Invalid coords' }, 400);
    if (!author || author.length > 80) return jsonResponse({ error: 'Invalid author name' }, 400);
    if (!text || text.length > 5000) return jsonResponse({ error: 'Invalid comment' }, 400);

    // Confirm doc exists — prevents writing comments for unregistered docs
    const exists = await env.DB.prepare('SELECT 1 FROM documents WHERE doc_id = ?').bind(docId).first();
    if (!exists) return jsonResponse({ error: 'Document not registered' }, 404);

    const annoRes = await env.DB.prepare(
        'INSERT INTO annotations (doc_id, page, x_pct, y_pct) VALUES (?, ?, ?, ?)'
    ).bind(docId, page, xPct, yPct).run();
    const annoId = annoRes.meta.last_row_id;

    const cRes = await env.DB.prepare(
        'INSERT INTO comments (annotation_id, author_name, body) VALUES (?, ?, ?)'
    ).bind(annoId, author, text).run();

    return jsonResponse({ annotation_id: annoId, comment_id: cRes.meta.last_row_id });
}

async function addComment(annoId, request, env) {
    const body = await readJson(request);
    const author = (body.author_name || '').trim();
    const text = (body.body || '').trim();
    const docId = body.doc_id;

    if (!docId || !DOC_ID_PATTERN.test(docId)) return jsonResponse({ error: 'Invalid doc_id' }, 400);
    if (!author || author.length > 80) return jsonResponse({ error: 'Invalid author name' }, 400);
    if (!text || text.length > 5000) return jsonResponse({ error: 'Invalid comment' }, 400);

    const check = await env.DB.prepare(
        'SELECT 1 FROM annotations WHERE id = ? AND doc_id = ?'
    ).bind(annoId, docId).first();
    if (!check) return jsonResponse({ error: 'Annotation not found' }, 404);

    const res = await env.DB.prepare(
        'INSERT INTO comments (annotation_id, author_name, body) VALUES (?, ?, ?)'
    ).bind(annoId, author, text).run();

    return jsonResponse({ comment_id: res.meta.last_row_id });
}

async function toggleResolved(annoId, request, env) {
    const body = await readJson(request);
    const docId = body.doc_id;
    if (!docId || !DOC_ID_PATTERN.test(docId)) return jsonResponse({ error: 'Invalid doc_id' }, 400);

    const row = await env.DB.prepare(
        'SELECT resolved FROM annotations WHERE id = ? AND doc_id = ?'
    ).bind(annoId, docId).first();
    if (!row) return jsonResponse({ error: 'Annotation not found' }, 404);

    const newVal = row.resolved ? 0 : 1;
    await env.DB.prepare('UPDATE annotations SET resolved = ? WHERE id = ?').bind(newVal, annoId).run();
    return jsonResponse({ resolved: !!newVal });
}

async function deleteAnnotation(annoId, url, env) {
    const docId = url.searchParams.get('doc_id');
    const adminToken = url.searchParams.get('admin_token');

    if (!docId || !DOC_ID_PATTERN.test(docId)) return jsonResponse({ error: 'Invalid doc_id' }, 400);
    if (!adminToken || !ADMIN_TOKEN_PATTERN.test(adminToken)) return jsonResponse({ error: 'Invalid token' }, 400);

    const doc = await env.DB.prepare('SELECT admin_token_hash FROM documents WHERE doc_id = ?').bind(docId).first();
    if (!doc) return jsonResponse({ error: 'Document not found' }, 404);

    const submittedHash = await sha256(adminToken);
    if (!timingSafeEqual(submittedHash, doc.admin_token_hash)) {
        return jsonResponse({ error: 'Forbidden' }, 403);
    }

    const check = await env.DB.prepare(
        'SELECT 1 FROM annotations WHERE id = ? AND doc_id = ?'
    ).bind(annoId, docId).first();
    if (!check) return jsonResponse({ error: 'Annotation not found' }, 404);

    await env.DB.prepare('DELETE FROM annotations WHERE id = ?').bind(annoId).run();
    return jsonResponse({ ok: true });
}

// ============================================================
// Helpers
// ============================================================

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
}

async function readJson(request) {
    try { return await request.json(); }
    catch { return {}; }
}

async function sha256(text) {
    const buf = new TextEncoder().encode(text);
    const hashBuf = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
}
