
import nodemailer from "nodemailer";

// =====================================================
// BREVO SMTP CONFIGURATION
// =====================================================

const smtpUser = () => process.env.SMTP_USER?.trim();

const smtpPass = () =>
  process.env.SMTP_PASS?.trim().replace(/\s+/g, "");

let smtpTransporter = null;

// =====================================================
// SMTP TRANSPORTER
// =====================================================

export const getSmtpTransporter = () => {
  if (!smtpTransporter) {
    const port = Number(process.env.SMTP_PORT || 2525);

    smtpTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp-relay.brevo.com",
      port,
      secure: port === 465,

      auth: {
        user: smtpUser(),
        pass: smtpPass(),
      },

      pool: true,
      maxConnections: 3,

      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
  }

  return smtpTransporter;
};

// =====================================================
// EMAIL CONFIGURATION
// =====================================================

export const mailProvider = () => "smtp";

const smtpConfigured = () =>
  Boolean(smtpUser() && smtpPass());

export const mailConfigured = () =>
  smtpConfigured() && Boolean(process.env.MAIL_FROM_EMAIL?.trim());

// =====================================================
// SENDER ADDRESS
// =====================================================

const isRelayLogin = (email) =>
  /@smtp-brevo\.com$|@smtp-relay\./i.test(email || "");

export const fromAddress = (fallbackName = "Task Management") => {
  const email = process.env.MAIL_FROM_EMAIL?.trim();

  if (!email) {
    throw new Error(
      "[Mailer] MAIL_FROM_EMAIL is missing in Render Environment."
    );
  }

  if (isRelayLogin(email)) {
    throw new Error(
      "[Mailer] SMTP login cannot be used as sender. Use your verified Brevo sender email."
    );
  }

  return {
    email,
    name: process.env.MAIL_FROM_NAME?.trim() || fallbackName,
  };
};

// =====================================================
// DELIVER EMAIL USING BREVO SMTP
// =====================================================

export const deliverMail = async (
  { fromName, to, subject, text, html },
  transporter = null
) => {
  if (!smtpConfigured()) {
    throw new Error(
      "[Mailer] SMTP_USER or SMTP_PASS is missing in Render."
    );
  }

  if (!to || !subject) {
    throw new Error(
      "[Mailer] Recipient and subject are required."
    );
  }

  const from = fromAddress(fromName);

  const mailTransporter = transporter || getSmtpTransporter();

  console.log("[Mailer] Sending through Brevo SMTP:", {
    from: from.email,
    to,
    subject,
  });

  try {
    const info = await mailTransporter.sendMail({
      from: `"${from.name}" <${from.email}>`,
      to,
      subject,
      text,
      html,
    });

    console.log("[Mailer] Email accepted:", {
      messageId: info.messageId,
      response: info.response,
    });

    return {
      messageId: info.messageId || "",
    };

  } catch (error) {
    console.error("[Mailer] Email delivery failed:", {
      code: error.code,
      responseCode: error.responseCode,
      message: error.message,
    });

    throw error;
  }
};
