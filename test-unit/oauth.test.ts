import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as oauth from "oauth4webapi";
import { ApiClient } from "../src/client.ts";
import { accessToken } from "../src/oauth.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true });
  }
});

describe.serial("Cloudflare Access OAuth", () => {
  test("registers with PKCE, stores tokens, and refreshes them", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wr-oauth-"));
    temporaryDirectories.push(directory);
    const env = { XDG_CONFIG_HOME: directory } as NodeJS.ProcessEnv;
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; body: string; authorization: string | null }> = [];
    let authorizationUrl: URL | undefined;

    const fetchMock = async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = String(input);
      const body = init?.body?.toString() ?? "";
      requests.push({ url, body, authorization: new Headers(init?.headers).get("authorization") });
      if (url === "https://wr.example.com/") {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="https://wr.example.com/.well-known/cloudflare-access-protected-resource/"',
          },
        });
      }
      if (url.endsWith("/cloudflare-access-protected-resource/")) {
        return Response.json({
          resource: "https://wr.example.com/",
          authorization_servers: ["https://team.cloudflareaccess.com"],
        });
      }
      if (url === "https://team.cloudflareaccess.com/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: "https://team.cloudflareaccess.com",
          authorization_endpoint:
            "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/authorization",
          token_endpoint: "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/token",
          registration_endpoint:
            "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/registration",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.endsWith("/oauth/registration")) {
        const registration = JSON.parse(body) as { redirect_uris: string[] };
        return Response.json(
          {
            client_id: "client-id",
            redirect_uris: registration.redirect_uris,
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          },
          { status: 201 },
        );
      }
      if (url.endsWith("/oauth/token")) {
        const parameters = new URLSearchParams(body);
        const grantType = parameters.get("grant_type");
        if (grantType === "authorization_code") {
          const codeVerifier = parameters.get("code_verifier");
          const codeChallenge = authorizationUrl?.searchParams.get("code_challenge");
          if (
            !codeVerifier ||
            !codeChallenge ||
            (await oauth.calculatePKCECodeChallenge(codeVerifier)) !== codeChallenge
          ) {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
        }
        return Response.json({
          access_token: grantType === "refresh_token" ? "oauth:refreshed" : "oauth:initial",
          refresh_token: grantType === "refresh_token" ? "oauth:refresh-2" : "oauth:refresh-1",
          token_type: "Bearer",
          expires_in: 900,
        });
      }
      if (url === "https://wr.example.com/api/health") {
        return Response.json({ ok: true });
      }
      return originalFetch(input, init);
    };
    fetchMock.preconnect = originalFetch.preconnect;
    globalThis.fetch = fetchMock;

    try {
      const initial = await accessToken("https://wr.example.com", env, async (url) => {
        authorizationUrl = new URL(url);
        expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
        expect(authorizationUrl.searchParams.get("resource")).toBe("https://wr.example.com/");
        const redirect = authorizationUrl.searchParams.get("redirect_uri")!;
        const state = authorizationUrl.searchParams.get("state")!;
        await originalFetch(`${redirect}?code=authorization-code&state=${state}`);
      });
      expect(initial).toBe("oauth:initial");

      const registration = JSON.parse(
        requests.find((request) => request.url.endsWith("/oauth/registration"))!.body,
      ) as Record<string, unknown>;
      expect(registration).toMatchObject({
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        resource: "https://wr.example.com/",
      });
      expect(registration.redirect_uris).toEqual([
        expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/),
      ]);
      const tokenRequest = new URLSearchParams(
        requests.find(
          (request) =>
            request.url.endsWith("/oauth/token") &&
            request.body.includes("grant_type=authorization_code"),
        )!.body,
      );
      expect(tokenRequest.get("code")).toBe("authorization-code");
      expect(tokenRequest.get("code_verifier")).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
      expect(await oauth.calculatePKCECodeChallenge(tokenRequest.get("code_verifier")!)).toBe(
        authorizationUrl!.searchParams.get("code_challenge")!,
      );

      const path = join(directory, "wr", "oauth.json");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const stored = JSON.parse(readFileSync(path, "utf8")) as Record<
        string,
        { expiresAt: number; accessToken: string }
      >;
      stored["https://wr.example.com/"]!.expiresAt = 0;
      writeFileSync(path, `${JSON.stringify(stored)}\n`, { mode: 0o600 });

      const refreshed = await accessToken("https://wr.example.com", env);
      expect(refreshed).toBe("oauth:refreshed");
      expect(requests.some((request) => request.body.includes("grant_type=refresh_token"))).toBe(
        true,
      );

      const api = new ApiClient(
        { repositories: [], serverUrl: "https://wr.example.com", deviceId: "device-a" },
        env,
      );
      expect(await api.request<{ ok: boolean }>("/api/health")).toEqual({ ok: true });
      expect(requests.at(-1)?.authorization).toBe("Bearer oauth:refreshed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses an unexpired stored access token without network requests", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wr-oauth-cached-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "wr");
    mkdirSync(path);
    writeFileSync(
      join(path, "oauth.json"),
      `${JSON.stringify({
        "https://wr.example.com/": {
          authorizationServer: "https://team.cloudflareaccess.com",
          clientId: "client-id",
          accessToken: "cached-access-token",
          refreshToken: "cached-refresh-token",
          expiresAt: Date.now() + 60_000,
        },
      })}\n`,
      { mode: 0o600 },
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async () => {
        throw new Error("fetch should not be called");
      },
      { preconnect: originalFetch.preconnect },
    );
    try {
      expect(await accessToken("https://wr.example.com", { XDG_CONFIG_HOME: directory })).toBe(
        "cached-access-token",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not begin browser login when interaction is disabled", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wr-oauth-noninteractive-"));
    temporaryDirectories.push(directory);
    let opened = false;

    await expect(
      accessToken(
        "https://wr.example.com",
        { XDG_CONFIG_HOME: directory },
        () => {
          opened = true;
        },
        false,
      ),
    ).rejects.toThrow("Cloudflare Access authentication is required");
    expect(opened).toBe(false);
  });
});
