import { randomBytes } from "node:crypto";
// Test processes share this explicit key with their isolated child services, never the system keychain.
process.env.FOOD_SESSION_KEY ||= randomBytes(32).toString("hex");
export const sessionTestKey = Buffer.from(process.env.FOOD_SESSION_KEY, "hex");
