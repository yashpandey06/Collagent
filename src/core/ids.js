import { randomBytes, randomUUID } from 'node:crypto';

// Unambiguous alphabet (no 0/O, 1/I/L) for human-friendly invite codes.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function sessionCode(length = 5) {
  const bytes = randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

export function participantId() {
  return `p_${randomBytes(6).toString('hex')}`;
}

export function token() {
  return randomBytes(16).toString('hex');
}

export function uuid() {
  return randomUUID();
}
