import { NextResponse } from 'next/server';

import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';
import packageJson from '@/package.json';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Which build is serving this console.
 *
 * The desktop app asks for it when the backend is a deployment of the user's
 * own: that build is then not the app's, and can be ahead of or behind it, so
 * the menu bar names both. The console's own dashboard prints the number too —
 * this is the same figure for something that cannot read a page.
 */
export const GET = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  return NextResponse.json({ version: packageJson.version });
};
