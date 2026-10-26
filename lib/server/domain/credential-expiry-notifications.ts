import { getActiveConfig } from './config';
import { getCredentialExpiry, readCredentialRecords } from './credentials';
import { readStorageJson, writeStorageJson } from '../storage';

export const BARK_URL = 'https://api.day.app/push';

export const CREDENTIAL_EXPIRY_NOTIFICATION_THRESHOLDS = [
  { key: 'three_days', seconds: 3 * 24 * 60 * 60, label: '还有 3 天' },
  { key: 'one_day', seconds: 24 * 60 * 60, label: '还有 1 天' },
  { key: 'expired', seconds: 0, label: '已过期' },
] as const;

type ExpiryNotificationKey =
  (typeof CREDENTIAL_EXPIRY_NOTIFICATION_THRESHOLDS)[number]['key'];

interface ExpiryNotificationState {
  expiresAt: number;
  sent: Partial<
    Record<
      ExpiryNotificationKey,
      Partial<Record<'bark' | 'web' | 'desktop', boolean>>
    >
  >;
}

type ExpiryNotificationStates = Record<string, ExpiryNotificationState>;

const STATE_FILENAME = 'expiry_notifications.json';
const TICK_INTERVAL_MS = 30 * 60 * 1000;
const START_DELAY_MS = 10 * 1000;

const globalSchedulerState = globalThis as typeof globalThis & {
  __codebuddy2apiCredentialExpiryNotifications__?: {
    timer: ReturnType<typeof setInterval>;
  };
  __codebuddy2apiCredentialExpirySubscribers__?: Set<CredentialExpiryNotificationSubscriber>;
};

export type CredentialExpiryNotificationChannel = 'desktop' | 'web';

export interface CredentialExpiryNotificationEvent {
  body: string;
  credential: string;
  expiresAt: number;
  key: ExpiryNotificationKey;
  title: string;
}

interface CredentialExpiryNotificationSubscriber {
  channel: CredentialExpiryNotificationChannel;
  send: (event: CredentialExpiryNotificationEvent) => void;
}

const notificationSubscribers =
  globalSchedulerState.__codebuddy2apiCredentialExpirySubscribers__ ??
  new Set<CredentialExpiryNotificationSubscriber>();
globalSchedulerState.__codebuddy2apiCredentialExpirySubscribers__ =
  notificationSubscribers;

export const subscribeCredentialExpiryNotifications = (
  channel: CredentialExpiryNotificationChannel,
  send: (event: CredentialExpiryNotificationEvent) => void,
): (() => void) => {
  const subscriber = { channel, send };
  notificationSubscribers.add(subscriber);
  return () => notificationSubscribers.delete(subscriber);
};

export const publishCredentialExpiryNotification = (
  channel: CredentialExpiryNotificationChannel,
  event: CredentialExpiryNotificationEvent,
): number => {
  let delivered = 0;

  notificationSubscribers.forEach((subscriber) => {
    if (subscriber.channel !== channel) return;

    try {
      subscriber.send(event);
      delivered += 1;
    } catch (error) {
      console.warn(
        '[CodeBuddy2API] Credential expiry notification subscriber failed',
        error,
      );
    }
  });

  return delivered;
};

let stateMutationQueue: Promise<void> = Promise.resolve();

const loadNotificationStates = async (): Promise<ExpiryNotificationStates> => {
  const saved = await readStorageJson<unknown>('credentials', STATE_FILENAME);

  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};

  return Object.entries(
    saved as Record<string, unknown>,
  ).reduce<ExpiryNotificationStates>((result, [filename, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return result;
    }

    const expiresAt = Number((value as Record<string, unknown>).expiresAt);
    const sent = (value as Record<string, unknown>).sent;

    if (!Number.isFinite(expiresAt) || !sent || typeof sent !== 'object') {
      return result;
    }

    result[filename] = {
      expiresAt,
      sent: Object.fromEntries(
        CREDENTIAL_EXPIRY_NOTIFICATION_THRESHOLDS.filter(({ key }) =>
          Boolean((sent as Record<string, unknown>)[key]),
        ).map(({ key }) => {
          const value = (sent as Record<string, unknown>)[key];
          return [
            key,
            typeof value === 'boolean'
              ? { bark: value }
              : Object.fromEntries(
                  ['bark', 'web', 'desktop']
                    .filter((channel) =>
                      Boolean(
                        value &&
                        typeof value === 'object' &&
                        !Array.isArray(value) &&
                        (value as Record<string, unknown>)[channel],
                      ),
                    )
                    .map((channel) => [channel, true]),
                ),
          ];
        }),
      ),
    };
    return result;
  }, {});
};

const saveNotificationStates = async (
  states: ExpiryNotificationStates,
): Promise<void> => {
  await writeStorageJson('credentials', STATE_FILENAME, states);
};

const updateNotificationStates = async (
  mutation: (states: ExpiryNotificationStates) => void,
): Promise<ExpiryNotificationStates> => {
  const operation = stateMutationQueue.then(async () => {
    const states = await loadNotificationStates();
    mutation(states);
    await saveNotificationStates(states);
    return states;
  });
  stateMutationQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
};

export const sendBarkNotification = async ({
  body,
  token,
  title,
}: {
  body: string;
  token: string;
  title: string;
}): Promise<void> => {
  const normalizedToken = token.trim();

  if (!normalizedToken) {
    throw new Error('Bark token is empty');
  }

  const response = await fetch(BARK_URL, {
    body: JSON.stringify({
      body,
      device_key: normalizedToken,
      group: 'CodeBuddy2API',
      title,
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Bark returned ${response.status}`);
  }
};

const credentialName = (credential: {
  data: Record<string, unknown>;
  filename: string;
}): string => {
  const userInfo = credential.data.user_info;
  const email =
    userInfo && typeof userInfo === 'object'
      ? (userInfo as Record<string, unknown>).email
      : undefined;

  return String(email ?? credential.data.user_id ?? credential.filename);
};

export const runCredentialExpiryNotificationTick = async (
  now: Date = new Date(),
): Promise<string[]> => {
  const config = await getActiveConfig();
  const token = config.CODEBUDDY_BARK_TOKEN.trim();
  const barkEnabled =
    config.CODEBUDDY_CREDENTIAL_EXPIRY_NOTIFICATIONS_ENABLED && Boolean(token);
  const webEnabled =
    config.CODEBUDDY_CREDENTIAL_EXPIRY_WEB_NOTIFICATIONS_ENABLED;
  const desktopEnabled =
    config.CODEBUDDY_CREDENTIAL_EXPIRY_DESKTOP_NOTIFICATIONS_ENABLED;

  if (!barkEnabled && !webEnabled && !desktopEnabled) {
    return [];
  }

  const states = await loadNotificationStates();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const sentNotifications: string[] = [];

  for (const credential of await readCredentialRecords()) {
    const expiresAt = getCredentialExpiry(credential.data);

    if (expiresAt === null) continue;

    const currentState = states[credential.filename];
    const state: ExpiryNotificationState =
      currentState?.expiresAt === expiresAt
        ? currentState
        : { expiresAt, sent: {} };
    const remaining = expiresAt - nowSeconds;

    const threshold =
      remaining <= 0
        ? CREDENTIAL_EXPIRY_NOTIFICATION_THRESHOLDS.find(
            ({ key }) => key === 'expired',
          )
        : remaining <= 24 * 60 * 60
          ? CREDENTIAL_EXPIRY_NOTIFICATION_THRESHOLDS.find(
              ({ key }) => key === 'one_day',
            )
          : remaining <= 3 * 24 * 60 * 60
            ? CREDENTIAL_EXPIRY_NOTIFICATION_THRESHOLDS.find(
                ({ key }) => key === 'three_days',
              )
            : undefined;

    if (!threshold) continue;

    const thresholdState = state.sent[threshold.key] ?? {};
    const shouldSendBark = barkEnabled && !thresholdState.bark;
    const shouldSendWeb = webEnabled && !thresholdState.web;
    const shouldSendDesktop = desktopEnabled && !thresholdState.desktop;

    if (!shouldSendBark && !shouldSendWeb && !shouldSendDesktop) continue;

    const name = credentialName(credential);

    const body = `凭据 ${name} ${threshold.label}。过期时间：${new Date(
      expiresAt * 1000,
    ).toLocaleString()}`;
    const title = 'CodeBuddy2API 凭据提醒';
    let delivered = false;

    if (shouldSendBark) {
      try {
        await sendBarkNotification({
          body,
          title,
          token,
        });
        thresholdState.bark = true;
        delivered = true;
      } catch (error) {
        console.warn(
          `[CodeBuddy2API] Bark credential expiry notification failed for ${credential.filename}`,
          error,
        );
      }
    }

    if (shouldSendWeb) {
      const subscriberCount = publishCredentialExpiryNotification('web', {
        body,
        credential: name,
        expiresAt,
        key: threshold.key,
        title,
      });

      if (subscriberCount > 0) {
        thresholdState.web = true;
        delivered = true;
      }
    }

    if (shouldSendDesktop) {
      const subscriberCount = publishCredentialExpiryNotification('desktop', {
        body,
        credential: name,
        expiresAt,
        key: threshold.key,
        title,
      });

      if (subscriberCount > 0) {
        thresholdState.desktop = true;
        delivered = true;
      }
    }

    if (delivered) {
      state.sent[threshold.key] = thresholdState;
      states[credential.filename] = state;
      try {
        await updateNotificationStates((saved) => {
          saved[credential.filename] = state;
        });
        sentNotifications.push(`${credential.filename}:${threshold.key}`);
      } catch (error) {
        console.warn(
          `[CodeBuddy2API] Credential expiry notification state save failed for ${credential.filename}`,
          error,
        );
      }
    }
  }

  return sentNotifications;
};

export const startCredentialExpiryNotificationScheduler = (): void => {
  if (globalSchedulerState.__codebuddy2apiCredentialExpiryNotifications__) {
    return;
  }

  const timer = setInterval(() => {
    void runCredentialExpiryNotificationTick().catch((error) => {
      console.warn(
        '[CodeBuddy2API] Credential expiry notification tick failed',
        error,
      );
    });
  }, TICK_INTERVAL_MS);
  timer.unref?.();
  globalSchedulerState.__codebuddy2apiCredentialExpiryNotifications__ = {
    timer,
  };

  setTimeout(() => {
    void runCredentialExpiryNotificationTick().catch((error) => {
      console.warn(
        '[CodeBuddy2API] Credential expiry notification tick failed',
        error,
      );
    });
  }, START_DELAY_MS).unref?.();
};

export const stopCredentialExpiryNotificationScheduler = (): void => {
  const state =
    globalSchedulerState.__codebuddy2apiCredentialExpiryNotifications__;

  if (!state) return;

  clearInterval(state.timer);
  delete globalSchedulerState.__codebuddy2apiCredentialExpiryNotifications__;
};
