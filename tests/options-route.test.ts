// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  accountEnvironmentOptionsQuery,
  parseOptionsRoute,
  resolveRequestedEnv,
  subscribeOptionsRoute,
  type OptionsRoute,
} from "../entrypoints/options/options-route";
import type { DomainConfig } from "../entrypoints/tools/account-switch/types";

const domain: DomainConfig = { name: "Example", tags: [] };
let unsubscribe: (() => void) | undefined;

afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  document.body.innerHTML = "";
});

describe("options route", () => {
  it("parses section and an encoded environment key", () => {
    expect(parseOptionsRoute("?section=account-switch&editEnv=https%3A%2F%2Fexample.test%2Flogin"))
      .toEqual({ section: "account-switch", editEnv: "https://example.test/login" });
    expect(parseOptionsRoute("")).toEqual({});
  });

  it("notifies the initial route and subsequent popstate query changes", () => {
    window.history.replaceState({}, "", "/options.html?section=account-switch&editEnv=https%3A%2F%2Fold.test");
    const routes: OptionsRoute[] = [];
    unsubscribe = subscribeOptionsRoute((route) => routes.push(route));
    expect(routes).toEqual([{ section: "account-switch", editEnv: "https://old.test" }]);

    window.history.pushState({}, "", "/options.html?section=account-switch&editEnv=https%3A%2F%2Fnew.test%2Flogin");
    window.dispatchEvent(new PopStateEvent("popstate"));

    expect(routes.at(-1)).toEqual({ section: "account-switch", editEnv: "https://new.test/login" });
  });

  it("resolves only real own environment keys", () => {
    const domains = { "https://example.test/login": domain };
    expect(resolveRequestedEnv(domains, "https://example.test/login")).toBe("https://example.test/login");
    expect(resolveRequestedEnv(domains, "https://missing.test")).toBeNull();
    expect(resolveRequestedEnv(domains, "__proto__")).toBeNull();
    expect(resolveRequestedEnv(domains, undefined)).toBeNull();
  });

  it("serializes only section and editEnv without credentials or executable markup", () => {
    const query = accountEnvironmentOptionsQuery("https://example.test/login?next=<img src=x>");
    expect(query).toBe("section=account-switch&editEnv=https%3A%2F%2Fexample.test%2Flogin%3Fnext%3D%3Cimg+src%3Dx%3E");
    expect(query).not.toMatch(/password|username|cookie|token/i);
    document.body.innerHTML = "<div id=\"safe\">ok</div>";
    const route = parseOptionsRoute(`?${query}`);
    expect(route.editEnv).toBe("https://example.test/login?next=<img src=x>");
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("#safe")?.textContent).toBe("ok");
  });
});
