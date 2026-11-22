// Web Push without a library: VAPID (RFC 8292) to say who is sending, aes128gcm (RFC 8291) to encrypt the message.
import { createECDH, createHmac, createCipheriv, createPrivateKey, randomBytes, sign } from "node:crypto";

export type PushSub = { endpoint: string; p256dh: string; auth: string }; // keys base64url, as the browser gives them

export type Vapid = { publicKey: string; privateJwk: JsonWebKey }; // publicKey: raw P-256 point, base64url

export function makeVapid(): Vapid {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const pub = ecdh.getPublicKey();
  return {
    publicKey: pub.toString("base64url"),
    privateJwk: { kty: "EC", crv: "P-256", d: ecdh.getPrivateKey().toString("base64url"), x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33, 65).toString("base64url") },
  };
}

const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();

// The message body for one subscription (RFC 8291, a single record).
export function encrypt(sub: PushSub, plaintext: Buffer): Buffer {
  const uaPublic = Buffer.from(sub.p256dh, "base64url");
  const authSecret = Buffer.from(sub.auth, "base64url");
  const ecdh = createECDH("prime256v1");
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const salt = randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// The VAPID JWT for one push service (aud = its origin), good for 12 hours.
export function vapidJwt(v: Vapid, endpoint: string, subject: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud: new URL(endpoint).origin, exp: nowSec + 12 * 3600, sub: subject })}`;
  const key = createPrivateKey({ key: v.privateJwk, format: "jwk" });
  return `${unsigned}.${sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

// A push message must fit one 4096-byte record: 3993 bytes of plaintext at most (RFC 8291). Keep a margin.
export const MAX_PAYLOAD_BYTES = 3800;

// Shortens title and body (by characters, ending in "…") until the JSON fits in MAX_PAYLOAD_BYTES as UTF-8.
export function fitPayload<T extends { title: string; body: string; [k: string]: unknown }>(p: T): T {
  const size = (x: T) => Buffer.byteLength(JSON.stringify(x));
  let out = { ...p, title: [...p.title].slice(0, 200).join("") };
  if (out.title.length < p.title.length) out.title += "…";
  let chars = [...out.body];
  while (size(out) > MAX_PAYLOAD_BYTES && chars.length) {
    chars = chars.slice(0, Math.max(0, chars.length - Math.ceil((size(out) - MAX_PAYLOAD_BYTES) / 3) - 1));
    out = { ...out, body: chars.join("") + "…" };
  }
  return out;
}

// Sends one message. Returns the push service's status: 201 = taken, 404/410 = the subscription is gone.
export async function sendPush(v: Vapid, sub: PushSub, payload: { title: string; body: string; [k: string]: unknown }, subject: string): Promise<number> {
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${vapidJwt(v, sub.endpoint, subject)}, k=${v.publicKey}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(24 * 3600),
      Urgency: "high",
    },
    body: new Uint8Array(encrypt(sub, Buffer.from(JSON.stringify(fitPayload(payload))))),
    signal: AbortSignal.timeout(15_000),
  });
  await res.arrayBuffer().catch(() => {});
  return res.status;
}
