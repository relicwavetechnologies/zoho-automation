import { createHash, randomInt } from 'node:crypto';

const PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
const PASSWORD_LENGTH = 12;

export function newPassword(): string {
  let password = '';
  for (let index = 0; index < PASSWORD_LENGTH; index += 1) {
    password += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]!;
  }
  return password;
}

export function hashOf(password: string): string {
  return createHash('sha256').update(password, 'utf8').digest('hex');
}
