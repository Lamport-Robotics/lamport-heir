import { describe, expect, it } from "vitest";
import { type Message } from "../src/reminders/messages.ts";
import { generatePushKeys, parsePushSubscription, pushChannel, type PushSubscriptionJson } from "../src/reminders/push.ts";

const keys = { p256dh: "B".repeat(87), auth: "a".repeat(22) };
const sub = (endpoint: string, k = keys) => JSON.stringify({ endpoint, expirationTime: null, keys: k });
const message: Message = { subject: "Lamport Heir: 7 days left to check in", body: "Seven days are left." };
const config = { ...generatePushKeys(), subject: "mailto:heir@example.org" };

describe("reminders as browser notifications", () => {
  it("accepts the subscriptions browsers make", () => {
    for (const endpoint of ["https://fcm.googleapis.com/fcm/send/abc:def", "https://updates.push.services.mozilla.com/wpush/v2/gAAAA", "https://web.push.apple.com/QGuvx", "https://wns2-par02p.notify.windows.com/w/?token=abc"]) {
      expect(parsePushSubscription(sub(endpoint)).endpoint).toBe(endpoint);
    }
  });

  it("refuses an endpoint that is not a browser's push service: the service posts to it", () => {
    for (const endpoint of [
      "http://fcm.googleapis.com/fcm/send/abc", // not https
      "https://fcm.googleapis.com.example.net/fcm/send/abc", // a look-alike host
      "https://example.net/fcm.googleapis.com/abc",
      "https://127.0.0.1/hook", "https://localhost/hook", "https://169.254.169.254/latest/meta-data", // this machine and its neighbours
      "https://fcm.googleapis.com:8443/fcm/send/abc", // another port
      "https://user@fcm.googleapis.com/fcm/send/abc",
      "https://push.apple.com/abc", // the bare domain is not a push host
      "ftp://fcm.googleapis.com/abc", "not a url", "",
    ]) expect(() => parsePushSubscription(sub(endpoint)), endpoint).toThrow(/endpoint/);
  });

  it("refuses a subscription that is not one", () => {
    expect(() => parsePushSubscription("phone")).toThrow(/not JSON/);
    expect(() => parsePushSubscription("null")).toThrow(/lacks/);
    expect(() => parsePushSubscription(JSON.stringify({ endpoint: "https://fcm.googleapis.com/x" }))).toThrow(/lacks/);
    expect(() => parsePushSubscription(sub("https://fcm.googleapis.com/x", { p256dh: "short", auth: keys.auth }))).toThrow(/keys are not well formed/);
    expect(() => parsePushSubscription(sub("https://fcm.googleapis.com/x", { p256dh: keys.p256dh, auth: "has spaces in it !!!!!" }))).toThrow(/keys are not well formed/);
  });

  it("sends the subject and the text, and nothing to open", async () => {
    const sent: { subscription: PushSubscriptionJson; payload: string; options: { TTL: number; vapidDetails: { subject: string } } }[] = [];
    const channel = pushChannel(config, async (subscription, payload, options) => { sent.push({ subscription, payload, options }); });
    await channel.send(sub("https://fcm.googleapis.com/fcm/send/abc"), message);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!.payload)).toEqual({ title: message.subject, body: message.body });
    expect(sent[0]!.payload).not.toMatch(/https?:|url|click/i);
    expect(sent[0]!.options.TTL).toBe(86_400);
    expect(sent[0]!.options.vapidDetails.subject).toBe("mailto:heir@example.org");
    // only what a subscription is made of goes on: nothing else a page might have put in the JSON
    expect(Object.keys(sent[0]!.subscription).sort()).toEqual(["endpoint", "keys"]);
  });

  it("never posts for a subscription it refuses", async () => {
    let posts = 0;
    const channel = pushChannel(config, async () => { posts++; });
    await expect(channel.send(sub("https://127.0.0.1/hook"), message)).rejects.toThrow(/not a browser's push service/);
    expect(posts).toBe(0);
  });

  it("says when a browser's subscription has ended, and otherwise only that it failed", async () => {
    const failing = (statusCode?: number) => pushChannel(config, async () => { throw Object.assign(new Error("https://fcm.googleapis.com/fcm/send/abc refused, key=secret"), statusCode === undefined ? {} : { statusCode }); });
    for (const gone of [404, 410]) await expect(failing(gone).send(sub("https://fcm.googleapis.com/fcm/send/abc"), message)).rejects.toThrow(/subscription has ended/);
    const other = await failing(500).send(sub("https://fcm.googleapis.com/fcm/send/abc"), message).then(() => undefined, (e: Error) => e);
    expect(other?.message).toBe("the push service did not take the notification (500)");
    await expect(failing().send(sub("https://fcm.googleapis.com/fcm/send/abc"), message)).rejects.toThrow(/\(no answer\)/);
  });

  it("needs its own key pair and a way to be reached", () => {
    expect(() => pushChannel({ ...config, subject: "heir@example.org" })).toThrow(/mailto: or https:/);
    expect(() => pushChannel({ ...config, privateKey: "" })).toThrow(/no key pair/);
    const k = generatePushKeys();
    expect(k.publicKey).toMatch(/^[A-Za-z0-9_-]{80,100}$/);
    expect(k.privateKey).not.toBe(k.publicKey);
  });
});
