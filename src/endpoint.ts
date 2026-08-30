import { isIP } from "node:net";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function ipHost(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function isPrivateOrLoopbackIp(host: string): boolean {
  const version = isIP(host);
  if (version === 4) {
    const [a, b] = host.split(".").map(Number);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (version === 6) {
    const lower = host.toLowerCase();
    if (lower === "::1") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("fe80:")) return true;
    return false;
  }
  return false;
}

/** Plain HTTP OTLP is allowed on loopback and private VPC addresses only. */
export function allowsPlaintextOtlp(url: URL): boolean {
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  if (LOOPBACK_HOSTS.has(url.hostname)) return true;
  return isPrivateOrLoopbackIp(ipHost(url.hostname));
}
