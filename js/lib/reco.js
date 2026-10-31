'use strict';
/* ─── software recommendations (DOM-free) ───
   Which apps best open / edit each type. Keyed by the detected format id
   (js/lib/detect.js), with extension overrides for the ZIP-family document
   formats and the rest that share a signature. recommendFor(det, name) →
   [{ name, url }], never empty. */
const { recommendFor } = (() => {
  const APP = {
    keepassxc: { name: 'KeePassXC', url: 'https://keepassxc.org' },
    weasis:    { name: 'Weasis', url: 'https://weasis.org' },
    dicomedit: { name: 'Carino DICOM Editor', url: 'https://dcm.carino.systems/' },
    vlc:       { name: 'VLC', url: 'https://www.videolan.org' },
    mpv:       { name: 'mpv', url: 'https://mpv.io' },
    audacity:  { name: 'Audacity', url: 'https://www.audacityteam.org' },
    kid3:      { name: 'Kid3', url: 'https://kid3.kde.org' },
    mp3tag:    { name: 'Mp3tag', url: 'https://www.mp3tag.de' },
    gimp:      { name: 'GIMP', url: 'https://www.gimp.org' },
    xnview:    { name: 'XnView MP', url: 'https://www.xnview.com' },
    exiftool:  { name: 'ExifTool', url: 'https://exiftool.org' },
    okular:    { name: 'Okular', url: 'https://okular.kde.org' },
    libre:     { name: 'LibreOffice', url: 'https://www.libreoffice.org' },
    sevenzip:  { name: '7-Zip', url: 'https://www.7-zip.org' },
    peazip:    { name: 'PeaZip', url: 'https://peazip.github.io' },
    fontforge: { name: 'FontForge', url: 'https://fontforge.org' },
    sqlitebrowser: { name: 'DB Browser for SQLite', url: 'https://sqlitebrowser.org' },
    ghidra:    { name: 'Ghidra', url: 'https://ghidra-sre.org' },
    die:       { name: 'Detect It Easy', url: 'https://github.com/horsicq/Detect-It-Easy' },
    calibre:   { name: 'Calibre', url: 'https://calibre-ebook.com' },
    jadx:      { name: 'jadx', url: 'https://github.com/skylot/jadx' },
    jdgui:     { name: 'JD-GUI', url: 'https://java-decompiler.github.io' },
    gnupg:     { name: 'GnuPG / Kleopatra', url: 'https://gnupg.org' },
    kse:       { name: 'KeyStore Explorer', url: 'https://keystore-explorer.org' },
    openssl:   { name: 'OpenSSL', url: 'https://www.openssl.org' },
    mkvtoolnix:{ name: 'MKVToolNix', url: 'https://mkvtoolnix.download' },
    imhex:     { name: 'ImHex', url: 'https://imhex.werwolv.net' },
    vscode:    { name: 'VS Code', url: 'https://code.visualstudio.com' },
    inkscape:  { name: 'Inkscape', url: 'https://inkscape.org' },
    blender:   { name: 'Blender', url: 'https://www.blender.org' },
    wabt:      { name: 'WABT', url: 'https://github.com/WebAssembly/wabt' },
  };
  const RECO_BY_ID = {
    jpeg:['gimp','xnview','exiftool'], png:['gimp','xnview','exiftool'], gif:['gimp','xnview'],
    tiff:['gimp','xnview','exiftool'], webp:['gimp','xnview'], heic:['gimp','xnview','exiftool'], bmp:['gimp','xnview'],
    avif:['gimp','xnview'], svg:['inkscape'],
    pdf:['okular','libre','exiftool'],
    mp3:['kid3','mp3tag','vlc'], flac:['kid3','audacity','vlc'], ogg:['kid3','vlc'], wav:['audacity','vlc'],
    m4a:['vlc','mpv','kid3'],
    mp4:['vlc','mpv','exiftool'], avi:['vlc','mpv'], mkv:['vlc','mkvtoolnix','mpv'],
    zip:['sevenzip','peazip'], gz:['sevenzip','peazip'], '7z':['sevenzip','peazip'], rar:['sevenzip','peazip'], tar:['sevenzip','peazip'],
    font:['fontforge','exiftool'],
    cert:['kse','openssl'], pem:['kse','openssl'], key:['kse','openssl'], pgp:['gnupg'], kdbx:['keepassxc'],
    pe:['die','ghidra'], elf:['ghidra','die'], macho:['ghidra','die'], class:['jdgui','ghidra'], wasm:['wabt'],
    sqlite:['sqlitebrowser'], dicom:['dicomedit','weasis'], text:['vscode'], bin:['die','imhex','exiftool'],
    'other-image':['gimp','xnview'], 'other-audio':['vlc','audacity'], 'other-video':['vlc','mpv'],
  };
  const RECO_BY_EXT = {
    docx:['libre'], xlsx:['libre'], pptx:['libre'], odt:['libre'], ods:['libre'], odp:['libre'],
    epub:['calibre'], apk:['jadx'], jar:['jdgui'], svg:['inkscape','gimp'], ico:['gimp'],
    kdbx:['keepassxc'], crt:['kse','openssl'], cer:['kse','openssl'], der:['kse','openssl'],
    p12:['kse','openssl'], pfx:['kse','openssl'], stl:['blender'], obj:['blender'], glb:['blender'], gltf:['blender'],
  };
  const ext = (name) => { const m = /\.([^.\\/]+)$/.exec(name || ''); return m ? m[1].toLowerCase() : ''; };
  function recommendFor(det, name){
    const keys = RECO_BY_EXT[ext(name)] || RECO_BY_ID[det && det.id] || ['exiftool'];
    const seen = new Set(), out = [];
    keys.forEach(k => { if(APP[k] && !seen.has(k)){ seen.add(k); out.push(APP[k]); } });
    return out;
  }
  return { recommendFor };
})();

if(typeof module === 'object' && module && module.exports) module.exports = { recommendFor };
