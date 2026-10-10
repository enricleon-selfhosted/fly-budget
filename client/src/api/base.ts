// The API's address. The desktop app's preload sets __API_BASE__ to its own local server
// (the page may only ever talk to that one); the web app uses /api on its own origin
// (proxied to the server by Vite in development).
// (No `window` when pure modules that import this are tested in Node.)
export const API_BASE = (typeof window !== 'undefined' ? window.__API_BASE__ : undefined) ?? '/api';
