/**
 * What a reminder says. Plain text built from the chain's facts by template.
 *
 * Two rules from the spec, both tested:
 *
 * - **No message contains a link, to sign or to anything else.** A reminder that says "click here
 *   to check in" is exactly what a phisher sends. The owner opens the app they already have.
 * - No message asks for a key, a seed phrase or a code, or says anyone ever will.
 *
 * A message to a trusted contact says what they can do and what they cannot: they cannot move or
 * release anything; they can reach the owner.
 */
import { type Audience, type Notice } from "./schedule.ts";

export interface Message {
  subject: string;
  body: string;
}

function date(ts: bigint): string {
  return new Date(Number(ts) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function days(n: number): string {
  return `${n} day${n === 1 ? "" : "s"}`;
}

const OWNER_ACTS = "To stay in control, sign any action with your vault, or check in from the Heir page you set up. Open it yourself, from your own bookmark.";
const NEVER = "Lamport never asks for your words or your keys, and this message contains no link.";
const CONTACT_ROLE = "You are getting this because the vault's owner named you as a trusted contact. You cannot move or release anything, and nobody needs anything from you to do so. If you can reach the owner, tell them.";

/** The text of `notice` for `audience`. `label` is the owner's own name for the vault, if they gave one. */
export function renderNotice(notice: Notice, audience: Audience, label?: string): Message {
  const name = label ? `"${label}" (${notice.vault})` : notice.vault;
  const forOwner = audience === "owner";
  const tail = forOwner ? `${OWNER_ACTS}\n\n${NEVER}` : `${CONTACT_ROLE}\n\n${NEVER}`;
  const who = forOwner ? "your" : "the owner's";
  const at = notice.at !== undefined ? date(notice.at) : "";
  let subject: string;
  let lines: string[];
  switch (notice.kind) {
    case "deadline_ahead":
      subject = `Lamport Heir: ${days(notice.days!)} left to check in`;
      lines = [`The inactivity window of vault ${name} runs out in ${days(notice.days!)}, on ${at}.`, `After that, anyone may open a public waiting period, and if it runs out too, the vault is released to the heirs named in ${who} plan.`];
      break;
    case "overdue":
      subject = "Lamport Heir: the inactivity window has run out";
      lines = [`The inactivity window of vault ${name} ran out on ${at}.`, "Anyone may now open the waiting period. Nothing has been released, and nothing can be until a waiting period has been opened and has run its full length."];
      break;
    case "wait_opened":
      subject = "Lamport Heir: a waiting period is open";
      lines = [`Somebody has opened the waiting period of vault ${name}.`, `If the owner does nothing, the vault can be released to the heirs from ${at}.`, forOwner ? "Any signature with your vault, or one check-in, cancels it." : "Any signature or check-in by the owner cancels it."];
      break;
    case "release_ahead":
      subject = `Lamport Heir: release in ${days(notice.days!)}`;
      lines = [`The waiting period of vault ${name} ends in ${days(notice.days!)}, on ${at}.`, "After that, anyone may release the vault to the heirs.", forOwner ? "Any signature with your vault, or one check-in, cancels it." : "Any signature or check-in by the owner cancels it."];
      break;
    case "releasable":
      subject = "Lamport Heir: the waiting period is over";
      lines = [`The waiting period of vault ${name} ended on ${at}. Anyone may release the vault to the heirs now.`, forOwner ? "Until someone does, a signature with your vault or a check-in still cancels it." : "Until someone does, a signature or check-in by the owner still cancels it."];
      break;
    case "released":
      subject = "Lamport Heir: the vault has been released";
      lines = [`Vault ${name} has been released to ${notice.heir}.`, "This cannot be undone. The heirs named in the plan can claim with the claim kit they were given."];
      return { subject, body: `${lines.join("\n")}\n\n${forOwner ? NEVER : `${CONTACT_ROLE}\n\n${NEVER}`}` };
    case "plan_changed":
      subject = "Lamport Heir: the succession plan changed";
      lines = [
        `The succession plan of vault ${name} was changed with a vault signature:`,
        ...notice.changes!.map((c) => `  - ${c}`),
        ...(notice.earliestRelease !== undefined ? [`Nothing can be released under it before ${date(notice.earliestRelease)}, and any signature or check-in by the owner moves that date further out.`] : []),
        forOwner ? "If you did not make this change, sign a new plan with your vault now, and move your funds if your words may be known to someone else." : "If the owner did not mean to make this change, they need to know.",
      ];
      return { subject, body: `${lines.join("\n")}\n\n${forOwner ? NEVER : `${CONTACT_ROLE}\n\n${NEVER}`}` };
    case "robot_warning":
      subject = `Lamport Heir: your Pincer1 has not been touched (${days(notice.days!)} left)`;
      lines = [
        `The Pincer1 linked to vault ${name} reports that nobody has touched it for a long time. In ${days(notice.days!)} it will pass the robot's own wallet to the heir it was armed for.`,
        forOwner ? "Touching the robot resets its timer. This is the robot's own switch and its own wallet: it is separate from the vault, and a touch is not a check-in for the vault." : "A touch on the robot by the owner resets its timer.",
      ];
      return { subject, body: `${lines.join("\n")}\n\n${forOwner ? NEVER : `${CONTACT_ROLE}\n\n${NEVER}`}` };
    case "robot_released":
      subject = "Lamport Heir: your Pincer1 has passed on its wallet";
      lines = [`The Pincer1 linked to vault ${name} reports that it has passed the robot's own wallet to its heir (transaction ${notice.signature}).`, "This is the robot's switch, not the vault's: the vault is not affected by it."];
      return { subject, body: `${lines.join("\n")}\n\n${forOwner ? NEVER : `${CONTACT_ROLE}\n\n${NEVER}`}` };
    case "signature_due":
      subject = `Lamport Heir: a vault signature is due in ${days(notice.days!)}`;
      lines = [`Check-ins for vault ${name} stop counting on ${at}: they can stand in for a vault signature for two years at most.`, "Before then, sign any action with your vault. A small transfer to yourself is enough."];
      return { subject, body: `${lines.join("\n")}\n\n${NEVER}` };
  }
  return { subject, body: `${lines.join("\n")}\n\n${tail}` };
}
