/** 32 位小写十六进制本地主键，与 schema 的 `lower(hex(randomblob(16)))` 同形。 */
let counter = 0;

export function newLocalId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  counter = (counter + 1) % 0x10000;
  bytes[12] = (bytes[12] + (counter >> 8)) & 0xff;
  bytes[13] = (bytes[13] + (counter & 0xff)) & 0xff;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
