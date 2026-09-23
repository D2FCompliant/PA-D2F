const encoder = new TextEncoder();

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256Hex(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(encoder.encode(secret)).buffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, Uint8Array.from(body).buffer);
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const size = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < size; index += 1) difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  return difference === 0;
}
