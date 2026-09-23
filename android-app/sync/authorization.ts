import { utf8Encode } from './core';

/** Hermes has no browser btoa guarantee. Encode UTF-8 credentials without browser/Node globals. */
export function basicAuthorization(username: string, password: string): string {
  if (username.includes(':')) throw new Error('WebDAV 用户名不能包含冒号');
  const bytes = utf8Encode(`${username}:${password}`);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]; const second = bytes[index + 1] ?? 0; const third = bytes[index + 2] ?? 0;
    result += alphabet[first >> 2] + alphabet[((first & 3) << 4) | (second >> 4)]
      + (index + 1 < bytes.length ? alphabet[((second & 15) << 2) | (third >> 6)] : '=')
      + (index + 2 < bytes.length ? alphabet[third & 63] : '=');
  }
  return `Basic ${result}`;
}
