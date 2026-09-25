import { useEffect, useMemo, useState, useCallback } from 'react';
import { useFetchClient } from '@strapi/admin/strapi-admin';

// Custom "Blog Versions" page — replaces the raw Content Manager Edit View
// for blog-post-version. Two layouts driven by a single URL segment:
//
//   /plugins/blog-versions                      → list of blog posts that have versions
//   /plugins/blog-versions?post=<documentId>    → versions for a specific post
//
// We use a query param rather than nested routes because addMenuLink registers
// one URL only; this keeps everything inside the page component.

const BLOG_POST_UID = 'api::blog-post.blog-post';
const BLOG_POST_VERSION_UID = 'api::blog-post-version.blog-post-version';

const IGNORED_DIFF_KEYS = new Set(['id', 'documentId', 'createdAt', 'updatedAt', 'publishedAt']);

// ────────────────────────────── helpers ──────────────────────────────

function readPostParam() {
  if (typeof window === 'undefined') return null;
  return new URL(window.location.href).searchParams.get('post');
}
function setPostParam(documentId) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (documentId) url.searchParams.set('post', documentId);
  else url.searchParams.delete('post');
  window.history.pushState({}, '', url.toString());
}

function summarize(value, maxLen = 80) {
  if (value === null || value === undefined) return '∅';
  if (typeof value === 'string') {
    const trimmed = value.replace(/\s+/g, ' ').trim();
    return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen - 1)}…` : (trimmed || '""');
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? '' : 's'}]`;
  if (typeof value === 'object') {
    if (value?.url) return value.url;
    if (value?.name) return value.name;
    return `{${Object.keys(value).slice(0, 3).join(', ')}…}`;
  }
  return String(value);
}
function isEqualish(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}
function changedKeys(snapshot, current) {
  if (!snapshot || typeof snapshot !== 'object') return [];
  const keys = new Set([...Object.keys(snapshot), ...Object.keys(current || {})]);
  const out = [];
  for (const k of keys) {
    if (IGNORED_DIFF_KEYS.has(k)) continue;
    if (!isEqualish(snapshot[k], current?.[k])) out.push(k);
  }
  return out.sort();
}
function fullDiff(snapshot, current) {
  return changedKeys(snapshot, current).map((key) => ({
    key, from: snapshot?.[key], to: current?.[key],
  }));
}
function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return String(iso); }
}

// ────────────────────────────── styles ──────────────────────────────

const C = {
  page:      { padding: '32px 48px', maxWidth: 1120, margin: '0 auto', fontFamily: 'inherit', color: '#32324d' },
  h1:        { fontSize: 28, fontWeight: 700, margin: 0, color: '#32324d' },
  sub:       { color: '#666687', marginTop: 6, marginBottom: 24, fontSize: 14 },
  back:      { background: 'transparent', border: 'none', color: '#4945ff', cursor: 'pointer', padding: 0, fontSize: 14, marginBottom: 12 },
  card:      { background: '#fff', border: '1px solid #eaeaef', borderRadius: 6, marginBottom: 16, boxShadow: '0 1px 4px rgba(33,33,52,0.04)' },
  cardHead:  { padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid #f6f6f9' },
  cardBody:  { padding: '16px 20px' },
  pillRow:   { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  pill:      { background: '#f0f0ff', color: '#271fe0', borderRadius: 12, padding: '2px 10px', fontSize: 12, fontWeight: 500, border: '1px solid #d9d8ff', cursor: 'pointer' },
  pillActive:{ background: '#271fe0', color: '#fff', borderColor: '#271fe0' },
  pillMuted: { background: '#f6f6f9', color: '#666687', borderRadius: 12, padding: '2px 10px', fontSize: 12, border: '1px solid #eaeaef' },
  btnPrimary:{ background: '#4945ff', color: '#fff', border: 'none', borderRadius: 4, padding: '8px 16px', cursor: 'pointer', fontSize: 14, fontWeight: 600 },
  btnDisabled:{ background: '#c0c0cf', color: '#fff', border: 'none', borderRadius: 4, padding: '8px 16px', fontSize: 14, fontWeight: 600, cursor: 'not-allowed' },
  table:     { width: '100%', borderCollapse: 'collapse' },
  th:        { textAlign: 'left', padding: '12px 16px', fontSize: 11, fontWeight: 600, color: '#666687', textTransform: 'uppercase', letterSpacing: 0.4, borderBottom: '1px solid #eaeaef', background: '#fafafb' },
  td:        { padding: '14px 16px', fontSize: 14, borderBottom: '1px solid #f6f6f9' },
  tr:        { cursor: 'pointer' },
  empty:     { textAlign: 'center', padding: 48, color: '#666687' },
  diffBox:   { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 },
  diffFrom:  { background: '#fdecea', border: '1px solid #f5c2bd', padding: '10px 12px', borderRadius: 4, color: '#611a15', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13 },
  diffTo:    { background: '#eaf6ec', border: '1px solid #b6e2bd', padding: '10px 12px', borderRadius: 4, color: '#1e4620', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13 },
  diffLabel: { fontSize: 11, color: '#666', marginBottom: 4 },
  banner:    { padding: '10px 16px', borderRadius: 4, marginBottom: 16, fontSize: 14 },
  bannerOk:  { background: '#eaf6ec', color: '#1e4620', border: '1px solid #b6e2bd' },
  bannerErr: { background: '#fdecea', color: '#611a15', border: '1px solid #f5c2bd' },
};

// ────────────────────────────── data hooks ──────────────────────────────

function useBlogPostsWithVersions(get) {
  const [state, setState] = useState({ loading: true, error: null, rows: [] });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 1. Fetch all blog posts (CM endpoint respects role scoping —
        //    Author sees only their own, the existing src/index.js middleware).
        const postsRes = await get(
          `/content-manager/collection-types/${BLOG_POST_UID}` +
          `?fields[0]=id&fields[1]=documentId&fields[2]=title` +
          `&populate[author][fields][0]=name&populate[createdBy][fields][0]=firstname&populate[createdBy][fields][1]=lastname` +
          `&pagination[pageSize]=100&sort=updatedAt:desc`,
        );
        const posts = postsRes?.data?.results ?? postsRes?.data?.data ?? [];

        // 2. For each post, fetch version count + latest version date.
        //    One small request per post; with pageSize=1 + pagination meta
        //    this is much cheaper than fetching all versions.
        const rows = await Promise.all(
          posts.map(async (p) => {
            try {
              const vRes = await get(
                `/content-manager/collection-types/${BLOG_POST_VERSION_UID}` +
                `?filters[blogPost][id][$eq]=${p.id}` +
                `&fields[0]=id&fields[1]=versionNumber&fields[2]=createdAt` +
                `&sort=versionNumber:desc&pagination[pageSize]=1`,
              );
              const list  = vRes?.data?.results ?? vRes?.data?.data ?? [];
              const meta  = vRes?.data?.pagination ?? vRes?.data?.meta?.pagination ?? null;
              const count = meta?.total ?? list.length;
              return { post: p, versionCount: count, latest: list[0] ?? null };
            } catch {
              return { post: p, versionCount: 0, latest: null };
            }
          }),
        );

        if (!cancelled) {
          setState({
            loading: false,
            error: null,
            rows: rows.filter((r) => r.versionCount > 0),
          });
        }
      } catch (e) {
        if (!cancelled) setState({ loading: false, error: e?.message ?? 'Failed to load posts', rows: [] });
      }
    })();
    return () => { cancelled = true; };
  }, [get]);

  return state;
}

function useVersionsForPost(get, postDocumentId) {
  const [state, setState] = useState({ loading: true, error: null, post: null, current: null, versions: [] });

  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const postRes = await get(
        `/content-manager/collection-types/${BLOG_POST_UID}/${encodeURIComponent(postDocumentId)}`,
      );
      const post    = postRes?.data?.data ?? postRes?.data ?? null;
      const current = post;
      if (!post) throw new Error('Post not found');

      const vRes = await get(
        `/content-manager/collection-types/${BLOG_POST_VERSION_UID}` +
        `?filters[blogPost][id][$eq]=${post.id}` +
        `&sort=versionNumber:desc&pagination[pageSize]=50`,
      );
      const versions = vRes?.data?.results ?? vRes?.data?.data ?? [];

      setState({ loading: false, error: null, post, current, versions });
    } catch (e) {
      setState({ loading: false, error: e?.message ?? 'Failed to load versions', post: null, current: null, versions: [] });
    }
  }, [get, postDocumentId]);

  useEffect(() => { if (postDocumentId) reload(); }, [postDocumentId, reload]);

  return { ...state, reload };
}

// ────────────────────────────── views ──────────────────────────────

function PostsListView({ rows, onSelect }) {
  return (
    <div style={C.card}>
      <table style={C.table}>
        <thead>
          <tr>
            <th style={C.th}>Title</th>
            <th style={C.th}>Author</th>
            <th style={C.th}>Versions</th>
            <th style={C.th}>Latest version</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ post, versionCount, latest }) => (
            <tr
              key={post.documentId}
              style={C.tr}
              onClick={() => onSelect(post.documentId)}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#fafafb'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = ''; }}
            >
              <td style={{ ...C.td, fontWeight: 600, color: '#271fe0' }}>{post.title}</td>
              <td style={C.td}>{post.author?.name ?? post.createdBy ? `${post.createdBy?.firstname ?? ''} ${post.createdBy?.lastname ?? ''}`.trim() : '—'}</td>
              <td style={C.td}><span style={C.pillMuted}>{versionCount}</span></td>
              <td style={C.td}>{latest ? `v${latest.versionNumber} • ${fmtDate(latest.createdAt)}` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VersionCard({ version, current, onRestore, restoring, disabled }) {
  const [expanded, setExpanded] = useState(null); // key of expanded chip
  const keys = useMemo(() => changedKeys(version.snapshot, current), [version.snapshot, current]);

  const expandedRow = expanded
    ? fullDiff(version.snapshot, current).find((d) => d.key === expanded)
    : null;

  return (
    <div style={C.card}>
      <div style={C.cardHead}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>
            Version #{version.versionNumber}
            <span style={{ color: '#666687', fontWeight: 400, marginLeft: 8 }}>
              · {fmtDate(version.createdAt)}
            </span>
          </div>
          <div style={{ fontSize: 12, color: '#8e8ea9', marginTop: 4 }}>
            {keys.length === 0 ? 'Identical to current draft' : `${keys.length} field${keys.length === 1 ? '' : 's'} differ`}
          </div>
        </div>
        <button
          type="button"
          disabled={disabled || keys.length === 0}
          onClick={() => onRestore(version)}
          style={disabled || keys.length === 0 ? C.btnDisabled : C.btnPrimary}
          title={keys.length === 0 ? 'Nothing to restore — already matches draft' : 'Overwrite the current draft with this snapshot'}
        >
          {restoring ? 'Restoring…' : 'Restore this version'}
        </button>
      </div>
      {keys.length > 0 && (
        <div style={C.cardBody}>
          <div style={{ fontSize: 13, color: '#666687', marginBottom: 6 }}>Changed fields (click to expand)</div>
          <div style={C.pillRow}>
            {keys.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setExpanded(expanded === k ? null : k)}
                style={expanded === k ? { ...C.pill, ...C.pillActive } : C.pill}
              >
                {k}
              </button>
            ))}
          </div>
          {expandedRow && (
            <div style={C.diffBox}>
              <div style={C.diffFrom}>
                <div style={C.diffLabel}>this version ({expandedRow.key})</div>
                {summarize(expandedRow.from, 2000)}
              </div>
              <div style={C.diffTo}>
                <div style={C.diffLabel}>current draft ({expandedRow.key})</div>
                {summarize(expandedRow.to, 2000)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function VersionsView({ postDocumentId, onBack }) {
  const { get, post } = useFetchClient();
  const { loading, error, post: blogPost, current, versions, reload } = useVersionsForPost(get, postDocumentId);
  const [restoring, setRestoring] = useState(null); // versionId being restored
  const [banner, setBanner] = useState(null);

  async function handleRestore(version) {
    if (!window.confirm(`Restore version #${version.versionNumber}? The current draft will be overwritten — but you can always restore back via a newer version.`)) return;
    setRestoring(version.id);
    setBanner(null);
    try {
      const res = await post(
        `/admin/blog-posts/${encodeURIComponent(postDocumentId)}/restore/${version.id}`,
      );
      const ok = res?.data?.ok ?? res?.ok;
      if (!ok) throw new Error(res?.data?.error?.message ?? 'Restore failed');
      setBanner({ kind: 'ok', text: `Restored version #${version.versionNumber}. Publish the post to apply.` });
      await reload();
    } catch (e) {
      setBanner({ kind: 'err', text: e?.message ?? 'Restore failed' });
    } finally {
      setRestoring(null);
    }
  }

  return (
    <>
      <button type="button" onClick={onBack} style={C.back}>← All blog posts with versions</button>
      <h1 style={C.h1}>{blogPost?.title ?? 'Blog post'}</h1>
      <div style={C.sub}>Pick any version to inspect what changed, then restore if needed.</div>

      {banner && (
        <div style={{ ...C.banner, ...(banner.kind === 'ok' ? C.bannerOk : C.bannerErr) }}>
          {banner.text}
        </div>
      )}

      {loading && <div style={C.empty}>Loading versions…</div>}
      {error && !loading && <div style={{ ...C.banner, ...C.bannerErr }}>{error}</div>}
      {!loading && !error && versions.length === 0 && <div style={C.empty}>No versions yet — publish the post to create the first snapshot.</div>}

      {!loading && versions.map((v) => (
        <VersionCard
          key={v.id}
          version={v}
          current={current}
          onRestore={handleRestore}
          restoring={restoring === v.id}
          disabled={restoring != null && restoring !== v.id}
        />
      ))}
    </>
  );
}

// ────────────────────────────── root ──────────────────────────────

export default function BlogVersionsPage() {
  const { get } = useFetchClient();
  const [selectedPostDocId, setSelectedPostDocId] = useState(readPostParam());

  // Keep state in sync with the URL when the user hits back/forward.
  useEffect(() => {
    const onPop = () => setSelectedPostDocId(readPostParam());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const selectPost = (id) => { setPostParam(id); setSelectedPostDocId(id); };
  const goBack     = () => { setPostParam(null); setSelectedPostDocId(null); };

  const { loading, error, rows } = useBlogPostsWithVersions(get);

  if (selectedPostDocId) {
    return (
      <div style={C.page}>
        <VersionsView postDocumentId={selectedPostDocId} onBack={goBack} />
      </div>
    );
  }

  return (
    <div style={C.page}>
      <h1 style={C.h1}>Blog Versions</h1>
      <div style={C.sub}>Browse snapshot history for each blog post. Click a post to view its versions and restore.</div>

      {loading && <div style={C.empty}>Loading blog posts…</div>}
      {error && !loading && <div style={{ ...C.banner, ...C.bannerErr }}>{error}</div>}
      {!loading && !error && rows.length === 0 && (
        <div style={C.empty}>No blog posts with version history yet. Publish a post to create the first snapshot.</div>
      )}
      {!loading && rows.length > 0 && <PostsListView rows={rows} onSelect={selectPost} />}
    </div>
  );
}
