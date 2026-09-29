/**
 * What a request the shell makes of a backend carries.
 *
 * The cookie the console set, when it set one — a deployment signed in to in a
 * browser on its own page — and the token a deployment handed this app, when
 * the sign-in was made as a device and there is no session to hold. Both, when
 * there are two, because a deployment answers to either and the shell cannot
 * say which it will be asked for.
 */
export const authHeaders = ({
  cookie = '',
  token = '',
}: {
  cookie?: string;
  token?: string;
}): Record<string, string> => ({
  ...(cookie ? { cookie } : {}),
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});
