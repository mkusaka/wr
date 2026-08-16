import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { ApiClient } from "../src/client.ts";
import { setServerUrl } from "../src/config.ts";
import { ConfigSchema } from "../src/validation.ts";

describe("server URL", () => {
  test.each([
    "https://wr.example.com",
    "http://localhost:8787",
    "http://127.0.0.1:8787",
    "http://[::1]:8787",
  ])("allows %s", (serverUrl) => {
    expect(v.safeParse(ConfigSchema, { repositories: [], serverUrl }).success).toBe(true);
  });

  test("rejects external HTTP URLs", () => {
    expect(
      v.safeParse(ConfigSchema, { repositories: [], serverUrl: "http://wr.example.com" }).success,
    ).toBe(false);
  });

  test("rejects an external HTTP URL from the environment", () => {
    expect(
      () =>
        new ApiClient(
          { repositories: [], serverUrl: "https://wr.example.com", deviceId: "device-a" },
          { WR_SERVER_URL: "http://wr.example.com" },
        ),
    ).toThrow("server URL must use HTTPS unless it targets localhost");
  });

  test("rejects an invalid server URL before writing config", () => {
    expect(() => setServerUrl("not-a-url", {})).toThrow();
  });
});
