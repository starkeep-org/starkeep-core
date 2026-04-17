import { Resend } from "resend";

const resendApiKey = process.env.RESEND_API_KEY;
const emailFrom = process.env.EMAIL_FROM;

export function isEmailEnabled() {
  return Boolean(resendApiKey && emailFrom);
}

function getEmailFrom() {
  if (!emailFrom) {
    throw new Error("EMAIL_FROM is not configured");
  }
  return emailFrom;
}

function getResendClient() {
  if (!resendApiKey) {
    throw new Error("RESEND_API_KEY is not configured");
  }
  return new Resend(resendApiKey);
}

export async function sendMagicLinkEmail(to: string, url: string) {
  if (!isEmailEnabled()) {
    return false;
  }

  const resend = getResendClient();
  const from = getEmailFrom();
  await resend.emails.send({
    from,
    to,
    subject: "Your Starkeeper login link",
    html: `<p>Use this link to sign in to Starkeeper:</p><p><a href="${url}">${url}</a></p><p>This link expires in 15 minutes.</p>`,
  });
  return true;
}

export async function sendInviteEmail(to: string, url: string) {
  if (!isEmailEnabled()) {
    return false;
  }

  const resend = getResendClient();
  const from = getEmailFrom();
  await resend.emails.send({
    from,
    to,
    subject: "You're invited to Starkeeper",
    html: `<p>You have been invited to join a Starkeeper workspace.</p><p><a href="${url}">Accept invite</a></p><p>This link expires in 7 days.</p>`,
  });
  return true;
}
