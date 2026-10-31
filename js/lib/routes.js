'use strict';
/* ─── route resolution (DOM-free; js/router.js uses it, tests/routes.test.mjs
   checks it) ───
   A route is what comes before the first "&" in the hash: a module id
   ("file", "metadata") or a mode under one ("file/pages"). The routes map is
   route → workspace id, as ROUTES() builds it from the registry. */

// '#file/pages&x=1' → 'file/pages'. A malformed escape is read as written.
function fullRoute(hash){
  let raw = String(hash == null ? '' : hash).replace(/^#/, '');
  try { raw = decodeURIComponent(raw); } catch(_){}
  return raw.split('&')[0];
}

/* id and path as CarinoUI.slices hands them over (#file/pages → 'file',
   'pages'): the full 'id/path' when it is a route, else the module 'id' alone,
   else null. So #file/xyz falls back to the file screen. */
function resolveRoute(routes, id, path){
  if(!routes || !id) return null;
  const has = (k) => Object.prototype.hasOwnProperty.call(routes, k);
  if(path && has(id + '/' + path)) return routes[id + '/' + path];
  return has(id) ? routes[id] : null;
}
