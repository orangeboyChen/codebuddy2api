import { resumeAutoRotation } from '@/lib/server/credentials';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (): Promise<Response> => {
  return Response.json(resumeAutoRotation());
};
