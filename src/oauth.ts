import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as oauth from "oauth4webapi";
import * as v from "valibot";

const StoredTokenSchema = v.object({
  authorizationServer: v.pipe(v.string(), v.url()),
  clientId: v.pipe(v.string(), v.nonEmpty()),
  accessToken: v.pipe(v.string(), v.nonEmpty()),
  refreshToken: v.pipe(v.string(), v.nonEmpty()),
  expiresAt: v.number(),
});

const TokenFileSchema = v.record(v.string(), StoredTokenSchema);
type StoredToken = v.InferOutput<typeof StoredTokenSchema>;

function tokenFile(env: NodeJS.ProcessEnv): string {
  const configHome = env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, ".config") : undefined);
  if (!configHome) throw new Error("HOME or XDG_CONFIG_HOME is required");
  return join(configHome, "wr", "oauth.json");
}

function readStoredToken(baseUrl: string, env: NodeJS.ProcessEnv): StoredToken | undefined {
  const path = tokenFile(env);
  if (!existsSync(path)) return undefined;
  return v.parse(TokenFileSchema, JSON.parse(readFileSync(path, "utf8")))[baseUrl];
}

function writeStoredToken(baseUrl: string, token: StoredToken, env: NodeJS.ProcessEnv): void {
  const path = tokenFile(env);
  const tokens = existsSync(path)
    ? v.parse(TokenFileSchema, JSON.parse(readFileSync(path, "utf8")))
    : {};
  tokens[baseUrl] = token;
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

async function discoverAuthorizationServer(baseUrl: string) {
  const resource = new URL(baseUrl);
  const response = await fetch(resource, {
    headers: { accept: "application/json" },
    redirect: "manual",
  });
  const authenticate = response.headers.get("www-authenticate") ?? "";
  const metadataUrl = authenticate.match(/resource_metadata="([^"]+)"/)?.[1];
  if (!metadataUrl) throw new Error("Cloudflare Access Managed OAuth is not enabled");
  const resourceMetadata = (await (await fetch(metadataUrl)).json()) as {
    authorization_servers?: string[];
  };
  const issuer = resourceMetadata.authorization_servers?.[0];
  if (!issuer) throw new Error("Cloudflare Access authorization server is missing");
  const issuerUrl = new URL(issuer);
  return oauth.processDiscoveryResponse(
    issuerUrl,
    await oauth.discoveryRequest(issuerUrl, { algorithm: "oauth2" }),
  );
}

function storeToken(
  baseUrl: string,
  authorizationServer: string,
  clientId: string,
  token: oauth.TokenEndpointResponse,
  previousRefreshToken: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const refreshToken = token.refresh_token ?? previousRefreshToken;
  if (!refreshToken) throw new Error("Cloudflare Access did not return a refresh token");
  writeStoredToken(
    baseUrl,
    {
      authorizationServer,
      clientId,
      accessToken: token.access_token,
      refreshToken,
      expiresAt: Date.now() + (token.expires_in ?? 900) * 1000,
    },
    env,
  );
  return token.access_token;
}

async function refreshAccessToken(
  baseUrl: string,
  stored: StoredToken,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const issuer = new URL(stored.authorizationServer);
  const authorizationServer = await oauth.processDiscoveryResponse(
    issuer,
    await oauth.discoveryRequest(issuer, { algorithm: "oauth2" }),
  );
  const client: oauth.Client = { client_id: stored.clientId };
  const response = await oauth.refreshTokenGrantRequest(
    authorizationServer,
    client,
    oauth.None(),
    stored.refreshToken,
  );
  const token = await oauth.processRefreshTokenResponse(authorizationServer, client, response);
  return storeToken(
    baseUrl,
    authorizationServer.issuer,
    client.client_id,
    token,
    stored.refreshToken,
    env,
  );
}

async function login(
  baseUrl: string,
  env: NodeJS.ProcessEnv,
  openBrowser: (url: string) => void | Promise<void>,
): Promise<string> {
  const resource = new URL(baseUrl);
  const authorizationServer = await discoverAuthorizationServer(baseUrl);
  if (!authorizationServer.authorization_endpoint || !authorizationServer.registration_endpoint) {
    throw new Error("Cloudflare Access OAuth endpoints are incomplete");
  }

  let resolveCallback!: (url: URL) => void;
  const callback = new Promise<URL>((resolve) => {
    resolveCallback = resolve;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      resolveCallback(new URL(request.url));
      return new Response("Authentication complete. You can close this window.", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    },
  });
  const redirectUri = `http://127.0.0.1:${server.port}/callback`;

  try {
    const registration = await oauth.dynamicClientRegistrationRequest(authorizationServer, {
      client_name: "wr CLI",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      resource: resource.href,
    });
    const client = await oauth.processDynamicClientRegistrationResponse(registration);
    const codeVerifier = oauth.generateRandomCodeVerifier();
    const state = oauth.generateRandomState();
    const authorizationUrl = new URL(authorizationServer.authorization_endpoint);
    authorizationUrl.searchParams.set("client_id", client.client_id);
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set(
      "code_challenge",
      await oauth.calculatePKCECodeChallenge(codeVerifier),
    );
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("resource", resource.href);

    console.error("Opening Cloudflare Access login in your browser...");
    await openBrowser(authorizationUrl.href);
    const callbackUrl = await callback;
    const parameters = oauth.validateAuthResponse(authorizationServer, client, callbackUrl, state);
    const tokenResponse = await oauth.authorizationCodeGrantRequest(
      authorizationServer,
      client,
      oauth.None(),
      parameters,
      redirectUri,
      codeVerifier,
    );
    const token = await oauth.processAuthorizationCodeResponse(
      authorizationServer,
      client,
      tokenResponse,
    );
    return storeToken(baseUrl, authorizationServer.issuer, client.client_id, token, undefined, env);
  } finally {
    server.stop(true);
  }
}

export async function accessToken(
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  openBrowser: (url: string) => void | Promise<void> = (url) => {
    const opened = Bun.spawnSync(["open", url], { stdout: "ignore", stderr: "pipe" });
    if (opened.exitCode !== 0) throw new Error("Could not open the Cloudflare Access login page");
  },
): Promise<string> {
  const normalizedBaseUrl = new URL(baseUrl).href;
  const stored = readStoredToken(normalizedBaseUrl, env);
  if (stored && stored.expiresAt > Date.now() + 30_000) return stored.accessToken;
  if (stored) {
    try {
      return await refreshAccessToken(normalizedBaseUrl, stored, env);
    } catch (error) {
      if (!(error instanceof oauth.ResponseBodyError) || error.error !== "invalid_grant")
        throw error;
    }
  }
  return login(normalizedBaseUrl, env, openBrowser);
}
