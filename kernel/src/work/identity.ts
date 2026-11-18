import { randomBytes } from 'node:crypto';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encode(value: bigint, width: number): string {
  let result = '';
  for (let position = 0; position < width; position++) {
    result = alphabet[Number(value & 31n)] + result;
    value >>= 5n;
  }
  return result;
}

export function newUlid(): string {
  const time = BigInt(Date.now());
  const randomness = BigInt(`0x${randomBytes(10).toString('hex')}`);
  return encode(time, 10) + encode(randomness, 16);
}
