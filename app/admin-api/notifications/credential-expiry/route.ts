import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';
import {
  type CredentialExpiryNotificationChannel,
  subscribeCredentialExpiryNotifications,
  type CredentialExpiryNotificationEvent,
} from '@/lib/server/domain/credential-expiry-notifications';
import { createSseHeaders } from '@/lib/server/shared/sse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const encoder = new TextEncoder();

const encodeEvent = (event: CredentialExpiryNotificationEvent): Uint8Array =>
  encoder.encode(
    `event: credential-expiry\ndata: ${JSON.stringify(event)}\n\n`,
  );

export const GET = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) return authError;

  const channel = new URL(request.url).searchParams.get('channel');
  if (channel !== 'web' && channel !== 'desktop') {
    return Response.json(
      { error: 'Notification channel is required' },
      { status: 400 },
    );
  }

  let close = (): void => undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const finish = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        request.signal.removeEventListener('abort', finish);
        try {
          controller.close();
        } catch {
          return;
        }
      };
      const unsubscribe = subscribeCredentialExpiryNotifications(
        channel as CredentialExpiryNotificationChannel,
        (event) => {
          if (closed) return;
          try {
            controller.enqueue(encodeEvent(event));
          } catch {
            finish();
          }
        },
      );
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
        } catch {
          finish();
        }
      }, 25_000);
      close = finish;
      request.signal.addEventListener('abort', finish);
      controller.enqueue(encoder.encode(': connected\n\n'));
    },
    cancel() {
      close();
    },
  });

  return new Response(stream, { headers: createSseHeaders() });
};
