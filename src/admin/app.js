import { setPluginConfig, getPluginPresets } from '@_sh/strapi-plugin-ckeditor';

// Neither the legacy icon font nor `blog-content.css` is carried over from the
// shared CMS. Both exist there to preview a legacy "Book Trusted Vendors"
// widget (`.layout-cat-corousel`) embedded in posts migrated out of the old
// Rails app. This instance starts empty, so no post contains that markup, and
// ~424 KB of font files for content that does not exist is not worth shipping
// into the admin bundle.

const COLLECTION_PREFIX = '/content-manager/collection-types/';
const PARAMS_TO_STRIP = ['_q', 'filters', 'page'];

function getCollectionUid(pathname) {
  if (!pathname || !pathname.startsWith(COLLECTION_PREFIX)) return null;
  return pathname.slice(COLLECTION_PREFIX.length).split('/')[0] || null;
}

// Strapi keeps the list view's search/filter/page params in the URL, and
// carries them across when you switch collections from the sidebar — so
// jumping from a filtered Blog Post list to Blog Author lands on a list
// filtered by a field that collection does not have, which renders as an empty
// table with no visible cause.
function stripStaleParams() {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  let changed = false;
  for (const key of PARAMS_TO_STRIP) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (changed) {
    window.history.replaceState(window.history.state, '', url.toString());
  }
}

const config = {
  locales: [],
};

const register = (app) => {
  // CKEditor link decorators — gives editors UI checkboxes for nofollow /
  // sponsored / ugc, and makes external links automatically carry
  // rel="noopener noreferrer" target="_blank". Required by the SEO rule set.
  if (typeof setPluginConfig === 'function' && typeof getPluginPresets === 'function') {
    const presets = getPluginPresets();
    if (presets?.defaultHtml?.editorConfig) {
      const existingLink = presets.defaultHtml.editorConfig.link ?? {};
      presets.defaultHtml.editorConfig.link = {
        ...existingLink,
        decorators: {
          ...(existingLink.decorators ?? {}),
          addTargetToExternal: {
            mode: 'automatic',
            callback: (url) => /^https?:\/\//i.test(url ?? ''),
            attributes: { target: '_blank', rel: 'noopener noreferrer' },
          },
          toggleNoFollow: { mode: 'manual', label: 'Nofollow', attributes: { rel: 'nofollow' } },
          toggleSponsored: { mode: 'manual', label: 'Sponsored', attributes: { rel: 'sponsored' } },
          toggleUGC: { mode: 'manual', label: 'UGC', attributes: { rel: 'ugc' } },
        },
      };

      // Image toolbar. The preset defines every alignment style but only
      // exposes the wrapText/breakText groupers, so an author cannot reliably
      // centre or align an image. These buttons emit the image-style-* classes
      // the storefront's prose CSS already renders.
      const existingImage = presets.defaultHtml.editorConfig.image ?? {};
      presets.defaultHtml.editorConfig.image = {
        ...existingImage,
        toolbar: [
          'imageTextAlternative',
          'toggleImageCaption',
          'linkImage',
          '|',
          'imageStyle:inline',
          '|',
          'imageStyle:alignLeft',
          'imageStyle:alignCenter',
          'imageStyle:alignRight',
          '|',
          'imageStyle:alignBlockLeft',
          'imageStyle:alignBlockRight',
          '|',
          'resizeImage',
        ],
      };
      setPluginConfig({ presets: Object.values(presets) });
    }
  }

  // Custom menu link → the "Blog Versions" page. The default Content Manager
  // entry for blog-post-version is hidden by the server-side response filter in
  // `src/index.js`; this is the user-facing way in. Loaded lazily so it does not
  // bloat the admin bundle for users who never open it.
  if (app?.addMenuLink) {
    app.addMenuLink({
      to: '/plugins/blog-versions',
      icon: () => '🕓',
      intlLabel: { id: 'blog-versions.menu', defaultMessage: 'Blog Versions' },
      Component: () => import('./extensions/blog-versions-page.jsx'),
      permissions: [],
    });
  }
};

const bootstrap = () => {
  if (typeof window === 'undefined') return;

  let lastUid = getCollectionUid(window.location.pathname);

  const handleLocationChange = () => {
    const currentUid = getCollectionUid(window.location.pathname);
    if (currentUid && currentUid !== lastUid) {
      stripStaleParams();
    }
    lastUid = currentUid;
  };

  const originalPushState = window.history.pushState;
  window.history.pushState = function (...args) {
    const result = originalPushState.apply(this, args);
    handleLocationChange();
    return result;
  };

  const originalReplaceState = window.history.replaceState;
  window.history.replaceState = function (...args) {
    const result = originalReplaceState.apply(this, args);
    handleLocationChange();
    return result;
  };

  window.addEventListener('popstate', handleLocationChange);
};

export default {
  config,
  register,
  bootstrap,
};
