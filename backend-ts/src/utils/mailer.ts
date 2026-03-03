import nodemailer from 'nodemailer';

import { config } from '../config/env';

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (transporter) return transporter;

  if (!config.smtp.host || !config.smtp.user || !config.smtp.pass) {
    return null;
  }

  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.pass,
    },
  });

  return transporter;
}

export async function sendInviteMagicLinkEmail(params: {
  to: string;
  roleKey: string;
  magicLink: string;
  invitedBy: string;
}) {
  const tx = getTransporter();
  const subject = 'You are invited to join the workspace';
  const text = [
    `You were invited by ${params.invitedBy}.`,
    `Assigned role: ${params.roleKey}`,
    `Open this link to accept the invite: ${params.magicLink}`,
  ].join('\n');

  if (!tx) {
    // eslint-disable-next-line no-console
    console.info(`SMTP not configured. Invite link for ${params.to}: ${params.magicLink}`);
    return;
  }

  await tx.sendMail({
    from: config.smtp.from,
    to: params.to,
    subject,
    text,
  });
}
