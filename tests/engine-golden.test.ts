import { describe, expect, it, vi } from "vitest";
import fixtures from "./fixtures/runtime-golden.json";
import { runSpec } from "../entrypoints/tools/account-switch/runtime";
import type { HostBridge, HttpRequestDto, LoginRunInput } from "../entrypoints/tools/account-switch/runtime";
import type { SpecOpName } from "../entrypoints/tools/account-switch/spec/types";

const OPS: SpecOpName[] = [
  "clear.cookies", "clear.storage", "goto", "http.execute", "digest",
  "crypto.encrypt", "payload.build", "map", "auth.write", "auth.capture",
  "auth.restore", "fill", "click", "waitFor", "extract", "script",
];

describe("runtime golden fixtures", () => {
  for (const fixture of fixtures.cases) {
    it(fixture.id, async () => {
      const requests: HttpRequestDto[] = [];
      const setCookie = vi.fn(async () => undefined);
      const host: HostBridge = {
        capabilities: () => ({ specVersions: [2], ops: OPS, page: false, session: true, script: false }),
        http: {
          execute: async (request) => {
            requests.push(request);
            return {
              status: fixture.response.status,
              finalUrl: request.url,
              redirected: false,
              headers: {},
              text: fixture.response.text,
            };
          },
        },
        session: {
          listCookies: vi.fn(async () => []),
          removeCookie: vi.fn(async () => undefined),
          setCookie,
        },
      };
      const result = await runSpec(fixture.input as LoginRunInput, host, fixture.trial ? { trial: {} } : {});
      const trace = result.trace.map(({ duration: _duration, ...entry }) => entry);
      const { request: _request, ...expectedOutcome } = fixture.expected;
      expect({
        success: result.success,
        ...(!result.success ? { errorCode: result.errorCode } : {}),
        bindings: result.bindings,
        trace: JSON.parse(JSON.stringify(trace)),
        ...(fixture.expected.sessionWrites !== undefined ? { sessionWrites: setCookie.mock.calls.length } : {}),
      }).toEqual(expectedOutcome);
      if (fixture.expected.request) expect(requests).toEqual([fixture.expected.request]);
      expect(JSON.stringify(result.trace)).not.toContain("GOLDEN-PASSWORD-55");
    });
  }
});
