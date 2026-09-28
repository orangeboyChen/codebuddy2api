/**
 * The cookie the console signs in with.
 *
 * It lives on its own so the Electron shell can send it along without pulling
 * in the session module — and with it storage, WebAuthn and the database —
 * into the main process bundle.
 */
export const ADMIN_SESSION_COOKIE = 'codebuddy_admin_session';
