import { test } from "bun:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { accessPrincipal } from "../src/server/auth.js";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 }), issuer = "https://synthetic-test.cloudflareaccess.com", aud = "test-audience";
const pub = { ...keys.publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
function token(extra: Record<string, unknown> = {}, algorithm = "RS256") {
    const h = Buffer.from(JSON.stringify({ alg: algorithm, kid: "test-key" })).toString("base64url"), p = Buffer.from(JSON.stringify({ sub: "principal", iss: issuer, aud: [aud], exp: Math.floor(Date.now() / 1000) + 300, ...extra })).toString("base64url");
    return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), keys.privateKey).toString("base64url")}`;
}
test("Access authentication verifies RSA signature, issuer, audience and expiry", async () => {
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => { assert.equal(String(input), `${issuer}/cdn-cgi/access/certs`); return Response.json({ keys: [pub] }); }) as typeof globalThis.fetch;
    try {
        assert.deepEqual(await accessPrincipal(token(), issuer, aud, "device"), { id: "principal", device: "device", role: "operator" });
        for (const value of [token({ exp: 0 }), token({ aud: ["wrong"] }), token({ iss: "https://evil.invalid" }), token({}, "none"), token().replace(/.$/, "!")])
            await assert.rejects(accessPrincipal(value, issuer, aud, "device"));
    }
    finally {
        globalThis.fetch = oldFetch;
    }
});
