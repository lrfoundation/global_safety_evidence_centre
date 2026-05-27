# PDF Review (GitHub Pages + Cloudflare)

A self-managed PDF review tool. **You** push PDFs to a GitHub repo. **Anyone** with a link can view and comment on them — no GitHub account required, no login.

- PDFs live in your Git repo (version controlled, auth via your GitHub credentials)
- Comments live in a Cloudflare Worker + D1 database (free tier covers anything reasonable)
- Static frontend served by GitHub Pages (free)
- Pinpoint annotations, threading, resolve/reopen, admin delete

## Architecture

```
GitHub Pages (static frontend)           Cloudflare Worker + D1
─────────────────────────────            ─────────────────────────
index.html                               POST   /docs        register doc
app.js, style.css, config.js             GET    /annotations
docs/                                    POST   /annotations
├── manifest.json  (list of docs)        POST   /annotations/:id/comments
└── <doc_id>/                            PATCH  /annotations/:id/resolved
    ├── document.pdf                     DELETE /annotations/:id   (admin only)
    └── meta.json
```

## Quick setup

You'll need: a GitHub account, a Cloudflare account, and Node.js installed locally (for wrangler, the Cloudflare CLI).

### 1. Get the code

Clone or download this folder to your machine. Initialize as a Git repo and push to a new GitHub repo:

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR-USERNAME/pdf-review.git
git push -u origin main
```

### 2. Cloudflare setup (one-time)

```bash
# Install wrangler globally
npm install -g wrangler

# Authenticate (opens browser)
wrangler login

# Create the D1 database
cd worker
wrangler d1 create pdf-review-comments
```

The last command prints something like:
```
[[d1_databases]]
binding = "DB"
database_name = "pdf-review-comments"
database_id = "abc123-some-uuid-here"
```

**Copy the `database_id` value** into `worker/wrangler.toml`, replacing `PASTE_DATABASE_ID_HERE`.

### 3. Initialize the database schema

```bash
# From the worker/ directory
wrangler d1 execute pdf-review-comments --remote --file=schema.sql
```

(Use `--remote` to apply to the production database. Without that flag wrangler writes to a local dev-only copy.)

### 4. Deploy the worker

```bash
# Still in worker/
wrangler deploy
```

It will print your worker's URL, e.g. `https://pdf-review-comments.yourname.workers.dev`. **Copy this URL.**

### 5. Configure the frontend

Open `config.js` and fill in both fields:

```javascript
window.PDF_REVIEW_CONFIG = {
    WORKER_URL: 'https://pdf-review-comments.yourname.workers.dev',
    SITE_URL: 'https://YOUR-USERNAME.github.io/pdf-review',
};
```

Commit and push:
```bash
git add config.js
git commit -m "Configure worker and site URLs"
git push
```

### 6. Enable GitHub Pages

On GitHub: **repo → Settings → Pages → Source: Deploy from a branch → Branch: main, folder: / (root) → Save**.

Wait a minute. Your site is at `https://YOUR-USERNAME.github.io/pdf-review/`.

### 7. Test

Visit your site. You should see an empty docs list with "No documents have been added yet." That's correct.

## Adding a PDF

```bash
# Make the script executable once
chmod +x scripts/add-pdf.sh

# Add a PDF
./scripts/add-pdf.sh "Q3 Product Proposal" ~/Downloads/proposal.pdf
```

The script will:
1. Generate a random `doc_id` and `admin_token`
2. Copy the PDF into `docs/<doc_id>/document.pdf`
3. Write `docs/<doc_id>/meta.json`
4. Append an entry to `docs/manifest.json`
5. Register the doc with your Worker
6. Print your **review URL** and **admin URL**

Then commit and push:
```bash
git add docs/
git commit -m "Add Q3 proposal"
git push
```

Once GitHub Pages re-deploys (~30 seconds), the link is live. Send the review URL to whoever should comment.

### Script requirements

The `add-pdf.sh` script needs: `bash`, `curl`, `openssl`, and `jq`. On macOS install jq with `brew install jq`. On Linux it's usually `apt install jq` or `dnf install jq`.

## URL anatomy

- **Review URL** (public-ish): `https://YOUR-USERNAME.github.io/pdf-review/?doc=<doc_id>`
   - Anyone with this link can view and comment
   - The doc_id is 24 random hex chars (~96 bits of entropy) — effectively unguessable
- **Admin URL** (keep private): `https://YOUR-USERNAME.github.io/pdf-review/?doc=<doc_id>&admin=<token>`
   - Same as the review URL but unlocks delete buttons on each comment
   - Token is 48 hex chars

## Security model

- **Documents are protected by URL obscurity.** The doc_id is unguessable. Anyone with the URL can see the PDF; that's the trade-off you accepted by hosting on GitHub Pages without auth.
- **Worker writes are open to anyone.** Anyone who knows your worker URL and a valid doc_id can post comments. There's no rate limiting by default — add Cloudflare rate-limiting rules if needed.
- **Admin deletes are server-verified.** Admin tokens are SHA-256 hashed in D1; the Worker re-hashes submitted tokens for comparison (constant-time). Tokens never leave the URL.
- **Don't share admin URLs in chat/email** where someone might forward them. Send the review URL only, and keep the admin URL in your password manager.

## Costs

- GitHub Pages: free
- Cloudflare Workers: free up to 100,000 requests/day
- Cloudflare D1: free up to 5 GB storage and 5 million row reads/day

For an internal review tool, you will not approach these limits.

## File map

```
.
├── index.html              # Frontend shell (index page + review page)
├── app.js                  # Frontend logic
├── style.css               # Styles
├── config.js               # WORKER_URL and SITE_URL — edit these
├── docs/
│   ├── manifest.json       # List of all docs
│   └── <doc_id>/           # One folder per PDF
│       ├── document.pdf
│       └── meta.json
├── scripts/
│   └── add-pdf.sh          # Helper to add a new PDF
└── worker/
    ├── src/index.js        # Cloudflare Worker code
    ├── schema.sql          # D1 schema
    ├── wrangler.toml       # Worker config (paste database_id)
    └── package.json
```

## Operational tips

**Updating the worker.** Edit `worker/src/index.js`, then from the `worker/` directory run `wrangler deploy`. Live in seconds.

**Inspecting comments.** From `worker/`, run:
```bash
wrangler d1 execute pdf-review-comments --remote --command="SELECT * FROM comments ORDER BY id DESC LIMIT 10"
```

**Deleting a document.** Two parts: remove the doc folder from the repo (`git rm -r docs/<doc_id>/`) AND delete from D1:
```bash
wrangler d1 execute pdf-review-comments --remote --command="DELETE FROM documents WHERE doc_id = '<doc_id>'"
```
(Comments cascade-delete automatically.) Also remove the entry from `docs/manifest.json`.

**Rate limiting.** If spam becomes a problem: Cloudflare dashboard → Workers → your worker → Security → add a rate-limit rule (e.g. 10 POST requests per IP per minute).

## Known limitations

- **No realtime.** Comments appear on page refresh. Could add polling (every N seconds re-fetch annotations).
- **No notifications.** No emails or pings when someone comments.
- **Comments are anonymous (just a display name).** Anyone could impersonate anyone by typing their name. For an internal tool this is usually fine; if it's not, you'd need real auth.
- **PDFs are public to anyone with the URL.** If you need stronger document privacy, GitHub Pages is the wrong host — use the PHP version.

## License

Use it however you like.
