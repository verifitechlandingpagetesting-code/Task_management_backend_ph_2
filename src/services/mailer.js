// One place that actually delivers email.
//
// Many hosts (e.g. Render's free plan) block outgoing SMTP ports, so Gmail SMTP silently
// hangs / fails there. If an HTTPS email API key is set, mail goes through that API instead:
//   BREVO_API_KEY   → Brevo  (free tier; verify your sender address in Brevo first)
//   RESEND_API_KEY  → Resend (needs a verified domain to send to anyone)
// Otherwise the SMTP transporter passed in by the caller (Gmail etc.) is used.
//
// MAIL_FROM_EMAIL / MAIL_FROM_NAME set the sender; MAIL_FROM_EMAIL defaults to SMTP_USER.

const API_TIMEOUT_MS = 15000;

export const mailProvider = () => {
  if (process.env.BREVO_API_KEY?.trim()) return "brevo";
  if (process.env.RESEND_API_KEY?.trim()) return "resend";
  return "smtp";
};

const smtpConfigured = () =>
  Boolean(process.env.SMTP_USER?.trim() && process.env.SMTP_PASS?.trim());

/** true when some way of sending mail is configured */
export const mailConfigured = () => mailProvider() !== "smtp" || smtpConfigured();

export const fromAddress = (fallbackName = "Task Management") => ({
  email: process.env.MAIL_FROM_EMAIL?.trim() || process.env.SMTP_USER?.trim() || "no-reply@example.com",
  name: process.env.MAIL_FROM_NAME?.trim() || fallbackName,
});

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
export const deliverMail = async ({ fromName, to, subject, text, html }, smtpTransporter) => {
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

  const info = await smtpTransporter.sendMail({
    from: `"${from.name}" <${from.email}>`,
    to,
    subject,
    text,
    html,
  });
  return { messageId: info.messageId || "" };
};
