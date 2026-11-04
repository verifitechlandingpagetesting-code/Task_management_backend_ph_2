// One place that actually delivers email.
//
// Many hosts (e.g. Render's free plan) block outgoing SMTP ports, so Gmail SMTP silently
// hangs / fails there. If an HTTPS email API key is set, mail goes through that API instead:
//   BREVO_API_KEY   → Brevo  (free tier; verify your sender address in Brevo first)
//   RESEND_API_KEY  → Resend (needs a verified domain to send to anyone)
// Otherwise the SMTP transporter passed in by the caller (Gmail etc.) is used.
//
// SMTP (Brevo SMTP relay recommended on Render):
//   SMTP_HOST=smtp-relay.brevo.com  SMTP_PORT=2525  (Render free blocks 25/465/587, not 2525)
//   SMTP_USER=<login>@smtp-brevo.com  SMTP_PASS=<Brevo SMTP key>
//
// MAIL_FROM_EMAIL / MAIL_FROM_NAME set the sender. With Brevo the SMTP login is NOT a valid
// sender — MAIL_FROM_EMAIL must be an address verified in Brevo (Senders).

import nodemailer from "nodemailer";

const API_TIMEOUT_MS = 15000;

const smtpUser = () => process.env.SMTP_USER?.trim();
const smtpPass = () => process.env.SMTP_PASS?.trim().replace(/\s+/g, "");

let smtpTransporter = null;
/** Shared SMTP transporter (Brevo relay / Gmail / any SMTP). */
export const getSmtpTransporter = () => {
  if (!smtpTransporter) {
    const port = Number(process.env.SMTP_PORT || 587);
    smtpTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST?.trim() || "smtp.gmail.com",
      port,
      secure: port === 465, // 587 / 2525 → STARTTLS
      auth: { user: smtpUser(), pass: smtpPass() },
      pool: true, // reuse one connection for several attendee emails
      maxConnections: 3,
      // Fail fast: a blocked port must not hang requests for minutes
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
  }
  return smtpTransporter;
};

export const mailProvider = () => {
  if (process.env.BREVO_API_KEY?.trim()) return "brevo";
  if (process.env.RESEND_API_KEY?.trim()) return "resend";
  return "smtp";
};

const smtpConfigured = () => Boolean(smtpUser() && smtpPass());

/** true when some way of sending mail is configured */
export const mailConfigured = () => mailProvider() !== "smtp" || smtpConfigured();

// SMTP logins of relay services are not mailboxes and are rejected as "From"
const isRelayLogin = (email) => /@smtp-brevo\.com$|@smtp-relay\./i.test(email || "");

let warnedFrom = false;
export const fromAddress = (fallbackName = "Task Management") => {
  const configured = process.env.MAIL_FROM_EMAIL?.trim();
  const login = smtpUser();
  const email = configured || (!isRelayLogin(login) && login) || "";
  if (!email && !warnedFrom) {
    warnedFrom = true;
    console.warn("[mailer] MAIL_FROM_EMAIL is not set — set it to a sender verified in Brevo, emails will be rejected otherwise");
  }
  return { email: email || "no-reply@example.com", name: process.env.MAIL_FROM_NAME?.trim() || fallbackName };
};

const postJson = async (url, headers, body) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${data.message || data.name || "Email API error"} (HTTP ${res.status})`);
    err.responseCode = res.status;
    throw err;
  }
  return data;
};

/**
 * Deliver one message. Returns { messageId }. Throws on failure.
 * smtpTransporter: nodemailer transporter, used only when no API key is set.
 */
export const deliverMail = async ({ fromName, to, subject, text, html }, transporter = getSmtpTransporter()) => {
  const from = fromAddress(fromName);
  const provider = mailProvider();

  if (provider === "brevo") {
    const data = await postJson(
      "https://api.brevo.com/v3/smtp/email",
      { "api-key": process.env.BREVO_API_KEY.trim() },
      { sender: from, to: [{ email: to }], subject, htmlContent: html, textContent: text }
    );
    return { messageId: data.messageId || "" };
  }

  if (provider === "resend") {
    const data = await postJson(
      "https://api.resend.com/emails",
      { Authorization: `Bearer ${process.env.RESEND_API_KEY.trim()}` },
      { from: `${from.name} <${from.email}>`, to: [to], subject, html, text }
    );
    return { messageId: data.id || "" };
  }

  const info = await transporter.sendMail({
    from: `"${from.name}" <${from.email}>`,
    to,
    subject,
    text,
    html,
  });
  return { messageId: info.messageId || "" };
};
