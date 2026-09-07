import type { Conversion } from "./docling.js";
import type { Email, MailAddress } from "./mail.js";

const list = (addresses: MailAddress[]): string =>
  addresses.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");

/**
 * Renders one message as the agent's input: headers, body, then a section per
 * attachment. Failures are stated explicitly — the agent should know a document
 * existed rather than silently reasoning about an incomplete message.
 */
export function buildAgentInput(email: Email, conversions: Conversion[]): string {
  const parts: string[] = ["# Incoming email", ""];

  const header = (label: string, value: string | undefined): void => {
    if (value) parts.push(`**${label}:** ${value}`);
  };
  header("From", list(email.from));
  header("To", list(email.to));
  header("Cc", list(email.cc));
  header("Subject", email.subject);
  header("Date", email.date?.toISOString());

  parts.push("", "## Body", "", email.text?.trim() || "_(no plain-text body)_");

  for (const conversion of conversions) {
    parts.push("", `## Attachment: ${conversion.filename}`, "");
    parts.push(
      conversion.ok
        ? conversion.markdown.trim()
        : `_Conversion failed: ${conversion.reason}. The document was received but could not be read._`,
    );
  }

  return parts.join("\n");
}
