import { createRemoteJWKSet, jwtVerify } from "jose";

export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  LOCAL_DEV?: string;
};

export type Principal = { subject: string; email?: string };

export async function authenticateAccess(request: Request, env: Env): Promise<Principal> {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion) throw new Error("Cloudflare Access assertion is missing");
  const teamDomain = env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const issuer = `https://${teamDomain}`;
  const { payload } = await jwtVerify(
    assertion,
    createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)),
    { issuer, audience: env.ACCESS_AUD },
  );
  if (!payload.sub) throw new Error("Cloudflare Access subject is missing");
  return {
    subject: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
  };
}
