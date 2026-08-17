import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { ApiClient } from "../src/client.ts";
import { setServerUrl } from "../src/config.ts";
import { ConfigSchema, SlackThreadUrlSchema } from "../src/validation.ts";

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

describe("Slack thread URL", () => {
  test.each([
    "https://moqona.slack.com/archives/C0123456789/p1234567890123456?thread_ts=1234567890.123456",
    "https://moqona.slack.com/archives/C0123456789/p1234567890123456",
    "https://moqona.slack.com/archives/CABC123DE/p9999999999999999?thread_ts=9999999999.999999",
  ])("accepts %s", (url) => {
    expect(v.safeParse(SlackThreadUrlSchema, url).success).toBe(true);
  });

  test.each([
    "https://example.com/not-slack",
    "https://slack.com/archives/C0123456789/p1234567890123456",
    "https://moqona.slack.com/archives/C0123456789/p1234567890",
    "https://moqona.slack.com/archives/C0123456789/p1234567890123456?thread_ts=1234567890",
    "not-a-url",
  ])("rejects %s", (url) => {
    expect(v.safeParse(SlackThreadUrlSchema, url).success).toBe(false);
  });
});
