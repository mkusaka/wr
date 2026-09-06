import { createHmac, timingSafeEqual, createPublicKey, verify } from "node:crypto";
import { demand } from "../domain/util.js";
import { object, text, choice, integer, list } from "../protocol/validate.js";
import type { Principal } from "../domain/model.js";
export function secureEqual(a: string, b: string): boolean { const aa = Buffer.from(a), bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
export class Tokens {
    constructor(readonly secret: string, readonly workspace: string) { demand(secret.length >= 32, "CONFIGURATION", "Signing secret must be at least 32 characters", 500); }
    mint(principal: Principal, seconds = 86400): string {
        const encoded = Buffer.from(JSON.stringify({ ...principal, workspace: this.workspace, expires: Math.floor(Date.now() / 1000) + seconds })).toString("base64url");
        return `wn1.${encoded}.${createHmac("sha256", this.secret).update(encoded).digest("base64url")}`;
    }
    read(token: string): Principal {
        const [version, payload, signature, ...extra] = token.split(".");
        demand(version === "wn1" && payload && signature && !extra.length, "UNAUTHORIZED", "Invalid capability", 401);
        demand(secureEqual(signature, createHmac("sha256", this.secret).update(payload).digest("base64url")), "UNAUTHORIZED", "Invalid capability signature", 401);
        const x = object(JSON.parse(Buffer.from(payload, "base64url").toString()), ["id", "device", "role", "execution", "checks", "workspace", "expires"]);
        demand(x.workspace === this.workspace && integer(x.expires, "expires") > Date.now() / 1000, "UNAUTHORIZED", "Expired or wrong-workspace capability", 401);
        return { id: text(x.id, "principal"), device: text(x.device, "device"), role: choice(x.role, ["operator", "worker", "launcher", "collector"] as const), ...(x.execution ? { execution: text(x.execution, "execution") } : {}), ...(x.checks ? { checks: list(x.checks, v => text(v, "check")) } : {}) };
    }
}
const keyCache = new Map<string, {
    until: number;
    keys: Record<string, unknown>[];
}>();
/** Verify, do not merely decode, the Access assertion. The configured issuer supplies keys. */
export async function accessPrincipal(token: string, issuer: string, audience: string, device: string): Promise<Principal> {
    demand(/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer), "CONFIGURATION", "Invalid Access issuer", 500);
    const [header, payload, sig, ...rest] = token.split(".");
    demand(header && payload && sig && !rest.length, "UNAUTHORIZED", "Access JWT required", 401);
    const h = object(JSON.parse(Buffer.from(header, "base64url").toString())), p = object(JSON.parse(Buffer.from(payload, "base64url").toString()));
    demand(h.alg === "RS256" && typeof h.kid === "string", "UNAUTHORIZED", "Unsupported JWT algorithm", 401);
    const time = Date.now() / 1000;
    demand(p.iss === issuer && typeof p.exp === "number" && p.exp > time && (!p.nbf || typeof p.nbf === "number" && p.nbf <= time + 30), "UNAUTHORIZED", "Invalid Access claims", 401);
    demand((Array.isArray(p.aud) ? p.aud : [p.aud]).includes(audience), "UNAUTHORIZED", "Wrong Access audience", 401);
    let cached = keyCache.get(issuer);
    if (!cached || cached.until < Date.now() || !cached.keys.some(k => k.kid === h.kid)) {
        const response = await fetch(`${issuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
        demand(response.ok, "AUTH_UNAVAILABLE", "Cannot obtain Access signing keys", 503);
        const body = object(await response.json());
        cached = { until: Date.now() + 300000, keys: list(body.keys, x => object(x)) };
        keyCache.set(issuer, cached);
    }
    const key = cached.keys.find(k => k.kid === h.kid);
    demand(key && key.kty === "RSA", "UNAUTHORIZED", "Unknown Access signing key", 401);
    const publicKey = createPublicKey({ key: key as JsonWebKey, format: "jwk" });
    demand(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(sig, "base64url")), "UNAUTHORIZED", "Invalid Access signature", 401);
    return { id: text(p.sub, "Access subject"), device, role: "operator" };
}
