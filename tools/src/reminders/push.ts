/**
 * Reminders as browser notifications (Web Push). Needs no account anywhere: the service has a key
 * pair of its own (VAPID), a browser subscribes with the public half, and the service sends
 * through the push service of that browser's maker.
 *
 * A recipient here is a push subscription, as text: the JSON a browser hands the page.
 */
import webpush from "web-push";
import { type Message } from "./messages.ts";
import { type Channel } from "./service.ts";

export interface PushConfig {
  /** the service's VAPID key pair, base64url. The private half stays on the server. */
  publicKey: string;
  privateKey: string;
  /** who runs this service, for the push services to reach: a mailto: or https: address */
  subject: string;
}

export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * The push services browsers use. A subscription names the URL the service is to post to, and a
 * subscription comes from whoever fills in the form: without this list the service could be made
 * to post to any address, including ones only it can reach.
 */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^[a-z0-9-]+\.push\.apple\.com$/, /^[a-z0-9-]+\.notify\.windows\.com$/];

/** Reads a subscription as a browser gives it. Throws in words. */
export function parsePushSubscription(to: string): PushSubscriptionJson {
  let s: Partial<PushSubscriptionJson>;
  try { s = JSON.parse(to); } catch { throw new Error("the push subscription is not JSON"); }
  if (!s || typeof s !== "object" || typeof s.endpoint !== "string" || !s.keys || typeof s.keys.p256dh !== "string" || typeof s.keys.auth !== "string") throw new Error("the push subscription lacks an endpoint or its keys");
  let url: URL;
  try { url = new URL(s.endpoint); } catch { throw new Error("the push subscription's endpoint is not a URL"); }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || !PUSH_HOSTS.some((h) => h.test(url.hostname))) throw new Error("the push subscription's endpoint is not a browser's push service");
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(s.keys.p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(s.keys.auth)) throw new Error("the push subscription's keys are not well formed");
  return { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
}

/** A new VAPID key pair, for a service's first start. */
export function generatePushKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}

type Sender = (subscription: PushSubscriptionJson, payload: string, options: { vapidDetails: { subject: string; publicKey: string; privateKey: string }; TTL: number; urgency: "high" }) => Promise<unknown>;

/**
 * `send` is web-push's `sendNotification` unless a test passes its own. A notification carries the
 * subject and the text, and no address to open: the owner opens their own bookmark.
 */
export function pushChannel(config: PushConfig, send: Sender = (s, p, o) => webpush.sendNotification(s, p, o)): Channel {
  if (!/^(mailto:|https:\/\/)/.test(config.subject)) throw new Error("push is not configured: the service's contact must be a mailto: or https: address");
  if (!config.publicKey || !config.privateKey) throw new Error("push is not configured: the service has no key pair");
  return {
    async send(to: string, message: Message): Promise<void> {
      const subscription = parsePushSubscription(to);
      try {
        // a day to live: a reminder that arrives a week late is worse than the next one arriving on time
        await send(subscription, JSON.stringify({ title: message.subject, body: message.body }), { vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey }, TTL: 86_400, urgency: "high" });
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) throw new Error("this browser's subscription has ended: the owner has to turn notifications on again");
        throw new Error(`the push service did not take the notification (${status ?? "no answer"})`);
      }
    },
  };
}
