/**
 * The cookies the console keeps its own state in.
 *
 * They live apart from `routing` and `session` so the Electron shell can read
 * them without pulling next-intl — or storage and WebAuthn — into the main
 * process bundle.
 */
export const localeCookieName = 'codebuddy2api-locale';
export const localePreferenceCookieName = 'codebuddy2api-locale-preference';
