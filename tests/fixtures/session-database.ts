import { DatabaseSync } from "node:sqlite";
import { createDecipheriv } from "node:crypto";
import { join } from "node:path";
import { sessionTestKey } from "./session-key";
export function storedPayload(directory: string, id: string): Buffer {
  const db = new DatabaseSync(join(directory, "food.sqlite3"), { readOnly: true, timeout: 1000 });
  try { return Buffer.from(db.prepare("SELECT payload FROM sessions WHERE id=?").get(id)!.payload as Uint8Array); }
  finally { db.close(); }
}
export function storedSnapshot(directory: string, id: string): any {
  const bytes = storedPayload(directory, id);
  if (bytes[0] !== 1) throw new Error("Unexpected encryption format");
  const decipher = createDecipheriv("aes-256-gcm", sessionTestKey, bytes.subarray(1, 13));
  decipher.setAAD(Buffer.from(id)); decipher.setAuthTag(bytes.subarray(13, 29));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString());
}
