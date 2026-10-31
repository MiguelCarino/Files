'use strict';
/* ─── modules: File · Images · Signature · Transcode, each at its own #hash ───
   The received file still decides where you go: showTool() moves there and
   writes the hash, and the slice bar (CarinoUI.slices) follows hashchange, so
   a link, Back or a slice click lands on the same module. PDF → Images and
   OCR are not modules: both run on the file screen itself. */

/* ─── workspace registry ───
   Each workspace script registers itself here:
     { id, route?, parent?, mode?, order, accepts(info, files) → bool,
       outcomes(info, files) → [{ id, icon, title, desc, run, rank?, more?, pin? }],
       setOutcomes?(set) → [ …same shape… ],     set = [{ file, info }]
       onShow?(), onHide?(), enter?(state), exit?() }
   A workspace with a route is a module: its section is #tool-<id> and its
   slice is #<route>. One without a route only contributes outcome cards.
   A mode (spec §2) is a workspace whose route sits under a module's slice,
   route: 'file/pages', parent: 'auto', mode: true: its own section, reached
   from a card, with that module's slice still lit. A mode never shows "Same
   file:" chips and is never one; enter(state) runs when it comes on screen
   (with FilesApp.state, or what enterMode handed it), exit() when it leaves.
   The file screen builds its cards from outcomes(), ranked (js/lib/outcomes.js). */
const FilesApp = {
  workspaces: [],
  register(ws){
    const i = this.workspaces.findIndex(w => w.id === ws.id);
    if(i >= 0) this.workspaces[i] = ws; else this.workspaces.push(ws);
    return ws;
  },
  get(id){ return this.workspaces.find(w => w.id === id) || null; },
  // Every card the accepting workspaces offer, each stamped with its
  // workspace's order, ranked: rank (descending), then order.
  _collect(hook, test, args){
    const out = [];
    this.workspaces.forEach(w => {
      if(typeof w[hook] !== 'function') return;
      try { if(test && !test(w)) return; } catch(_){ return; }
      const list = w[hook].apply(w, args) || [];
      list.forEach(o => { if(o) out.push(Object.assign({ order: w.order || 0 }, o)); });
    });
    return rankOutcomes(out);
  },
  outcomes(info, files){
    return this._collect('outcomes', w => typeof w.accepts === 'function' && w.accepts(info, files), [info, files]);
  },
  // The set view's cards (§9): each workspace's optional setOutcomes(set).
  setOutcomes(set){
    return this._collect('setOutcomes', null, [set || []]);
  },
  // The file on the file screen, as receive() last saw it. set: the files
  // held together (the tray), or null.
  state: { files: [], file: null, info: null, set: null },
  // Every way a file comes in goes through the file screen, which identifies
  // it and sets state. opts.open names a workspace to open it in instead of
  // staying on the file screen (only 'metadata' so far).
  intake(files, opts){ return AutoTool.receive(files, opts); },
  // The file on the file screen, opened in a workspace that has open().
  openIn(id){
    const ws = this.get(id), s = this.state;
    if(ws && s.file && typeof ws.open === 'function') ws.open(s.file, s.info);
    showTool(id);
  },
  /* A mode, entered from a card or a chip. state: what the mode works on
     (FilesApp.state when left out). opener: the control that opened it
     (a .oc-card), which gets focus back when the mode is left. */
  enterMode(id, state, opener){
    const ws = this.get(id);
    if(!ws || !ws.mode) return;
    modeIn = { state: state || null, opener: opener || null, oc: opener && opener.dataset ? opener.dataset.oc || null : null };
    showTool(id);
  },
  // Done, Esc and Back: back to the mode's parent (the file screen).
  leaveMode(){
    const ws = this.get(activeTool);
    if(!ws || !ws.mode) return;
    showTool(ws.parent || 'auto');
  },
};
// Looked up at call time: the workspaces register after this script runs.
// Keyed by the full route, so 'file/pages' maps to 'pages'.
const ROUTES = () => FilesApp.workspaces.reduce((m, w) => { if(w.route) m[w.route] = w.id; return m; }, { file: 'auto' });
const TOOLS = () => ['auto'].concat(FilesApp.workspaces.filter(w => w.route).map(w => w.id));
const routeOf = (tool) => tool === 'auto' ? 'file' : ((FilesApp.get(tool) || {}).route || tool);
let wsFileName = '';
function setWsFile(name){
  wsFileName = name || '';
  document.querySelectorAll('.ws-file').forEach(el => {
    el.textContent = wsFileName;
    el.classList.toggle('hidden', !wsFileName);
  });
}
/* ─── same file, another workspace ───
   Every workspace's top bar (not the file screen's, not a mode's) carries one
   chip per other workspace that accepts the file on the file screen. A chip
   runs that workspace's first outcome, as its card on the file screen would,
   or opens the file there. The chip names are the workspaces' own pane
   titles, which i18n.js has already translated. */
function renderSameFile(){
  const s = FilesApp.state;
  TOOLS().forEach(id => {
    if(id === 'auto') return;
    const self = FilesApp.get(id);
    if(self && self.mode) return;
    const bar = document.querySelector('#tool-' + id + ' .pane-bar');
    if(!bar) return;
    let box = bar.querySelector('.same-file');
    if(!box){
      box = document.createElement('span');
      box.className = 'same-file hidden';
      box.setAttribute('role', 'group');
      // After the file's name when the bar shows one, else after the title.
      const after = bar.querySelector('.ws-file') || bar.querySelector('.pane-title');
      after.after(box);
    }
    box.innerHTML = '';
    const others = !s.file ? [] : FilesApp.workspaces
      .filter(w => w.route && !w.mode && w.id !== id && typeof w.accepts === 'function')
      .filter(w => { try { return !!w.accepts(s.info, s.files); } catch(_){ return false; } })
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    box.classList.toggle('hidden', !others.length);
    if(!others.length) return;
    const label = document.createElement('span');
    label.className = 'sf-label';
    setText(label, 'Same file:');
    box.setAttribute('aria-label', T('Same file:'));
    box.append(label);
    others.forEach(w => {
      const title = document.querySelector('#tool-' + w.id + ' .pane-title');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip-tag';
      b.dataset.ws = w.id;
      b.textContent = title ? title.textContent.trim() : w.id;
      b.addEventListener('click', () => {
        const st = FilesApp.state;
        if(!st.file) return;
        const first = typeof w.outcomes === 'function' && (w.outcomes(st.info, st.files) || [])[0];
        if(first && typeof first.run === 'function') first.run();
        else FilesApp.openIn(w.id);
      });
      box.append(b);
    });
  });
}
window.addEventListener('files:i18n', () => renderSameFile());

/* ─── modes: the Done chip, Esc, focus back (spec §2.6) ───
   modeDoneChip(section): the mode's pane-bar gains a button.chip-tag "Done"
   right after its .ws-file (or its title); it, browser Back and Esc go back
   to #file. The card that opened the mode gets focus again when it is still
   there (looked up by its data-oc id, since the cards are re-rendered). */
let activeTool = 'auto';
let modeIn = null;      // { state, opener, oc } handed over by enterMode, until the mode shows
let modeBack = null;    // { opener, oc } of the mode on screen, for the way back
function modeDoneChip(section){
  const bar = section && section.querySelector('.pane-bar');
  if(!bar) return null;
  let b = bar.querySelector('.mode-done');
  if(b) return b;
  b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip-tag mode-done';
  setText(b, 'Done');
  b.addEventListener('click', () => FilesApp.leaveMode());
  const after = bar.querySelector('.ws-file') || bar.querySelector('.pane-title');
  if(after) after.after(b); else bar.prepend(b);
  return b;
}
function modeOpener(back){
  if(!back) return null;
  if(back.oc){
    const card = document.querySelector('#auto-outcomes .oc-card[data-oc="' + CSS.escape(back.oc) + '"]');
    if(card) return card;
  }
  return back.opener && back.opener.isConnected && back.opener.offsetParent !== null ? back.opener : null;
}
// Capture phase: this runs before carino-ui.js closes an open menu on the
// same Esc, so a menu still counts as open here and keeps the Esc to itself.
window.addEventListener('keydown', e => {
  if(e.key !== 'Escape' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  const ws = FilesApp.get(activeTool);
  if(!ws || !ws.mode) return;
  if(window.CarinoUI && CarinoUI.modal && CarinoUI.modal.top()) return;
  if(document.querySelector('.cs-menu-panel:not([hidden])')) return;
  if(inTextField(document.activeElement)) return;
  e.preventDefault();
  FilesApp.leaveMode();
}, true);

/* noFocus: the first route on page load, which should not grab focus.
   Otherwise a shown workspace takes focus on its title (tabindex=-1), so a
   screen reader says where it landed; the empty file screen focuses its
   dropzone instead, and leaving a mode focuses the card that opened it. */
function showTool(name, quiet, noFocus){
  const tools = TOOLS();
  if(!tools.includes(name)) name = 'auto';
  const prev = activeTool, moved = prev !== name;
  const prevWs = FilesApp.get(prev);
  const leftMode = moved && prevWs && prevWs.mode ? modeBack : null;
  if(moved && prevWs){
    if(typeof prevWs.onHide === 'function') prevWs.onHide();
    if(prevWs.mode){ if(typeof prevWs.exit === 'function') prevWs.exit(); modeBack = null; }
  }
  activeTool = name;
  tools.forEach(t => $('tool-' + t).classList.toggle('active', t === name));
  // A workspace may want to know it is on screen (metadata opens the file
  // from the file screen when it does not have it yet).
  const ws = FilesApp.get(name);
  if(ws && typeof ws.onShow === 'function') ws.onShow();
  // A mode starts on its way in (a card, a link, Back), or again when a
  // card hands it something new while it is already up.
  if(ws && ws.mode && (moved || modeIn)){
    const hand = modeIn;
    modeIn = null;
    if(hand) modeBack = { opener: hand.opener, oc: hand.oc };
    else if(moved) modeBack = null;
    if(typeof ws.enter === 'function') ws.enter(hand && hand.state ? hand.state : FilesApp.state);
  }
  renderSameFile();
  if(quiet) return;
  if(!noFocus){
    const empty = name === 'auto' && $('auto-result').classList.contains('hidden');
    let target = empty ? $('auto-drop') : $('tool-' + name).querySelector('.pane-title');
    const back = leftMode && modeOpener(leftMode);
    if(back) target = back;
    if(target && document.activeElement !== target) target.focus({ preventScroll: !back });
  }
  // The hash follows; the router then calls back here and finds nothing to
  // do. Compared on the full route (file/pages, not file), so a mode and its
  // module never bounce the hash between them.
  const now = fullRoute(location.hash);
  const want = routeOf(name);
  if(now !== want && !(name === 'auto' && !ROUTES()[now])) location.hash = '#' + want;
}
showTool('auto', true);   // until the router reads the hash
// Deferred, so carino-ui.js (also deferred) has defined CarinoUI by then.
// CarinoUI.slices lights the module before the "/" (#file/pages lights File);
// onRoute resolves the full route, falling back to the module (#file/xyz is
// the file screen).
document.addEventListener('DOMContentLoaded', () => {
  let first = true;   // the page-load route leaves focus where the browser put it
  if(window.CarinoUI) CarinoUI.slices({
    menu: $('modules'), collapsed: true,
    onRoute: (id, params) => {
      showTool(resolveRoute(ROUTES(), id, params && params.path) || 'auto', false, first);
      first = false;
      // No hash is the file screen too: keep its slice lit.
      if(!id) document.querySelector('#modules .slice[data-id="file"]').classList.add('active');
    },
  });
});
