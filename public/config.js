// Where the chat/admin server runs.
// Leave empty when the page is served by that server itself (node server.js).
// For a static copy (e.g. GitHub Pages) put the server's public https address here,
// and add this page's origin to ALLOWED_ORIGINS on the server.
// Local development (http://localhost / 127.0.0.1) keeps using the local server.
window.AIWEB_API = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
  ? ''
  : (location.hostname.endsWith('github.io') ? 'https://aiweb-production-a50d.up.railway.app' : '');
