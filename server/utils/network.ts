import { isIP } from "node:net";

function normalizeAddress(value: string): string {
  let address = value
    .replace(/^\[|\]$/g, "")
    .split("%")[0]!
    .toLowerCase();
  if (isIP(address) === 6) {
    address = new URL(`http://[${address}]`).hostname.slice(1, -1);
    // Node may expose IPv4 peers as IPv4-mapped IPv6 addresses.
    const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(address);
    if (mapped) {
      const high = parseInt(mapped[1]!, 16),
        low = parseInt(mapped[2]!, 16);
      address = `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    }
  }
  return address;
}

function isLoopback(address: string): boolean {
  return (
    address === "::1" || (isIP(address) === 4 && address.startsWith("127."))
  );
}

function isPrivate(address: string): boolean {
  if (isIP(address) === 4) {
    const [first, second] = address.split(".").map(Number);
    return (
      first === 10 ||
      (first === 172 && second! >= 16 && second! <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }
  if (isIP(address) === 6) {
    const prefix = parseInt(address.split(":")[0]!, 16);
    return (prefix & 0xfe00) === 0xfc00 || (prefix & 0xffc0) === 0xfe80;
  }
  return false;
}

export function isAllowedHost(hostname: string, allowLan: boolean): boolean {
  const address = normalizeAddress(hostname);
  return (
    address === "localhost" ||
    isLoopback(address) ||
    (allowLan && isPrivate(address))
  );
}

export function isAllowedPeer(
  remoteAddress: string | undefined,
  allowLan: boolean,
): boolean {
  if (!remoteAddress) return false;
  const address = normalizeAddress(remoteAddress);
  return isLoopback(address) || (allowLan && isPrivate(address));
}
