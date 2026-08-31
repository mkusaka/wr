import { hostname } from "node:os";
import * as v from "valibot";
import { accessToken } from "./oauth.ts";
import { ServerUrlSchema, type Config } from "./validation.ts";

export class ApiClient {
  readonly baseUrl: string;
  readonly headers: Record<string, string>;
  readonly local: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly interactiveAuth: boolean;

  constructor(config: Config, env: NodeJS.ProcessEnv = process.env, interactiveAuth = true) {
    this.interactiveAuth = interactiveAuth;
    this.env = env;
    this.baseUrl = env.WR_SERVER_URL
      ? v.parse(ServerUrlSchema, env.WR_SERVER_URL)
      : (config.serverUrl ?? "");
    if (!this.baseUrl) throw new Error("Server is not configured; set WR_SERVER_URL");
    const url = new URL(this.baseUrl);
    this.local =
      url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    this.headers = {
      "X-Wr-Device-Id": config.deviceId!,
      "X-Wr-Device-Name": hostname(),
    };
  }

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      ...init,
      headers: {
        accept: "application/json",
        ...(this.local
          ? {}
          : {
              authorization: `Bearer ${await accessToken(
                this.baseUrl,
                this.env,
                undefined,
                this.interactiveAuth,
              )}`,
            }),
        ...this.headers,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    const body = (await response.json()) as { error?: string } & T;
    if (!response.ok) throw new Error(body.error ?? `Server returned ${response.status}`);
    return body;
  }
}
