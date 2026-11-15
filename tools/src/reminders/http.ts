/**
 * The one thing the reminder service listens for: an owner's Pincer1 posting its own warnings.
 *
 *   POST /robot/<secret>   { "event": "inheritance_warning", "daysLeft": 7, "at": ... }
 *                          { "event": "inheritance_released", "signature": "...", "at": ... }
 *
 * The answer is 204 whatever was sent: a caller learns nothing about which addresses exist. A body
 * larger than a few kilobytes is dropped. Nothing posted here can do more than cause a reminder.
 */
import { createServer, type Server } from "node:http";
import { type ReminderService } from "./service.ts";

const MAX_BODY = 4096;

export function robotHookServer(service: ReminderService, log: (line: string) => void = () => {}): Server {
  return createServer((req, res) => {
    const done = () => {
      res.statusCode = 204;
      res.end();
    };
    const match = req.method === "POST" ? /^\/robot\/([A-Za-z0-9_-]{16,128})$/.exec(req.url ?? "") : null;
    if (!match) {
      req.resume();
      return done();
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on("end", () => {
      done();
      if (size > MAX_BODY) return;
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return;
      }
      service.robotEvent(match[1]!, body).then(
        (queued) => queued && log("a robot event was queued as a reminder"),
        (e: unknown) => log(`robot event failed: ${(e as Error).message}`),
      );
    });
    req.on("error", done);
  });
}
