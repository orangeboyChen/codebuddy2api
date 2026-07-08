import { getModelsResponse } from '@/lib/server/codebuddy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (): Promise<Response> => {
  return getModelsResponse();
};
