'use strict';

/**
 * Build the flat list of field paths — including component sub-fields in
 * dot notation — that Strapi expects in a permission's `properties.fields`.
 *
 * This is not a nicety. A permission granted with a bare `"seo"` or `"faqs"`
 * leaves those sections in the **indeterminate** (minus) state in Settings →
 * Roles, and an editor holding that role cannot fill them in: the form renders
 * the section but every field inside it is read-only. Strapi only considers a
 * component enabled when every one of its sub-field paths (`seo.metaTitle`,
 * `seo.openGraph.ogImage`, `faqs.question`, …) is listed individually.
 *
 * Timestamps and internal attributes come back in this list too; Strapi ignores
 * them downstream, and filtering them here would mean keeping a second list of
 * what "internal" means in step with Strapi's own.
 */
function getFieldPaths(strapi, uid, prefix = '') {
  const ct = strapi.contentTypes?.[uid] || strapi.components?.[uid];
  if (!ct?.attributes) return [];

  const paths = [];
  for (const [key, attr] of Object.entries(ct.attributes)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (attr.type === 'component') {
      // The component key itself, then everything inside it, recursively.
      paths.push(fullKey);
      paths.push(...getFieldPaths(strapi, attr.component, fullKey));
    } else {
      paths.push(fullKey);
    }
  }
  return paths;
}

module.exports = { getFieldPaths };
