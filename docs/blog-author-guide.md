# Blog Author Guide

Practical guidance for writing and editing WeddingGiftBox blog posts so the
published page renders cleanly and stays SEO-correct.

## Pasting from Google Docs or Word

Copying directly from Google Docs or Word and pasting into the **Content** editor
smuggles in the source app's markup. The most common side effect: a heading gets
wrapped in a list item (`<ol start="3"><li><h3>…</h3></li></ol>`), which renders
on the live page as a stray number floating just before the heading.

**Always paste as plain text:**

- **Windows / Linux:** `Ctrl` + `Shift` + `V`
- **macOS:** `Cmd` + `Shift` + `V`

Then re-apply formatting — headings, bold, links, lists — with the editor's
toolbar.

> Safety net: `wgb-backend` also unwraps headings that were pasted inside list
> items when it serves the post, so an older post renders without the stray
> number. Pasting as plain text is still the right habit; it keeps the stored
> content clean at the source rather than relying on a repair on the way out.

## Slugs

- Slugs are **always stored in lowercase**. Type or paste a capitalised one and
  it is lowercased on save.
- A published post's slug **can** be corrected. Changing only the casing
  (`…-Chennai` → `…-chennai`) saves with no other effect.
- Changing a published slug to something genuinely different **automatically
  creates a 301 redirect** from the old URL to the new one, so existing links and
  search rankings survive. Avoid changing published slugs unless you need to.

## Images

Recommended widths, so a large upload does not break the mobile layout:

- **Mobile:** up to 360 px
- **Desktop:** up to 1088 px

Use the editor's image alignment controls (left / right / centre / inline) — the
live page honours them.

Two things the storefront strips from pasted content, so do not rely on them:

- **Embeds.** `<iframe>` is removed, so a YouTube or Maps embed pasted into the
  body will not appear. Link to it instead.
- **Base64 images.** An image pasted as a `data:` URI is removed. Upload it
  through the editor's image button so it becomes a real media file.

## Read time and view count

Both are computed, and neither appears on the form.

- **Read time** is derived from the content every time you save.
- **View count** is incremented when the storefront serves the published post.
  A value typed into a REST call is discarded — the counter is not editable by
  design.

## Versions

Every **publish** snapshots the post. Open **Blog Versions** in the sidebar to
browse a post's history, see which fields differ from the current draft, and
restore one.

- Restoring overwrites the **current draft**, not the live page. Publish
  afterwards to make it live.
- Restoring never moves the slug — a rollback should not silently change a URL.
- Versions are read-only. They are written by the CMS on publish, which is why
  they are not editable in the Content Manager.
- An Author can restore versions of their own posts; Editors and Admins can
  restore any.

## SEO and FAQs

Both sections live at the bottom of the post form.

- `metaTitle` is capped at 60 characters and `metaDescription` at 160 — those are
  the limits at which search results truncate.
- Leave `metaTitle` / `metaDescription` empty and the storefront falls back to
  the post's title and excerpt.
- **`structuredData`**, if you fill it in, *replaces* the JSON-LD the storefront
  would otherwise generate for the post. Leave it empty unless you know exactly
  what you are overriding.

## Preview

The **Preview** button opens the draft on the storefront as it will look
published. If the button is missing, `PREVIEW_SECRET` is not configured on this
instance — that is a deployment setting, not something you can fix from the
admin panel.
