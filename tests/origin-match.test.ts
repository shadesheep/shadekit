/**
 * origin 归一化与匹配（登录 origin 防线的公共底座）。
 *
 * 覆盖两类历史回归：
 * - Chromium 会把 host 中的 `*` 编码成 `%2A`，通配符环境不能被 new URL 直接归一；
 * - 显式端口（尤其非默认端口）必须参与匹配，不能只看 hostname。
 */
import { describe, expect, it } from "vitest";
import {
  normalizedOrigin,
  originMatches,
} from "../entrypoints/tools/account-switch/utils/env";

describe("normalizedOrigin", () => {
  it("具体 URL 归一到 origin，丢弃 path/query/hash", () => {
    expect(
      normalizedOrigin(
        "http://app.dev.example.com:16800/app/#/dashboard/index?packageId=1",
      ),
    ).toBe("http://app.dev.example.com:16800");
  });

  it("协议与域名小写化", () => {
    expect(normalizedOrigin("HTTPS://APP.EXAMPLE.COM/Home")).toBe(
      "https://app.example.com",
    );
  });

  it("去掉协议默认端口（http:80 / https:443）", () => {
    expect(normalizedOrigin("http://example.com:80/a")).toBe("http://example.com");
    expect(normalizedOrigin("https://example.com:443/a")).toBe(
      "https://example.com",
    );
  });

  it("保留非默认端口", () => {
    expect(normalizedOrigin("http://example.com:16800/a")).toBe(
      "http://example.com:16800",
    );
    expect(normalizedOrigin("https://example.com:8443")).toBe(
      "https://example.com:8443",
    );
  });

  it("通配符 host 原样保留 *（不经过 new URL 的 %2A 编码）", () => {
    expect(normalizedOrigin("https://*.example.com")).toBe(
      "https://*.example.com",
    );
    expect(normalizedOrigin("https://*.example.com:443/home")).toBe(
      "https://*.example.com",
    );
    expect(normalizedOrigin("http://*.dev.example.com:16800/app")).toBe(
      "http://*.dev.example.com:16800",
    );
  });

  it("非法地址返回空串", () => {
    expect(normalizedOrigin("not-a-url")).toBe("");
    expect(normalizedOrigin("   ")).toBe("");
  });
});

describe("originMatches", () => {
  it("完全相同的 origin 命中（path/query/hash 不参与比较）", () => {
    expect(
      originMatches(
        "https://app.example.com",
        "https://app.example.com/#/dashboard/index?packageId=1",
      ),
    ).toBe(true);
  });

  it("协议不同不命中", () => {
    expect(
      originMatches("https://app.example.com", "http://app.example.com/home"),
    ).toBe(false);
  });

  it("端口不同不命中", () => {
    expect(
      originMatches(
        "http://app.dev.example.com:16800",
        "http://app.dev.example.com:16801/home",
      ),
    ).toBe(false);
  });

  it("默认端口写法差异仍视为同一 origin", () => {
    expect(originMatches("http://example.com:80", "http://example.com/a")).toBe(
      true,
    );
    expect(
      originMatches("https://example.com", "https://example.com:443/a"),
    ).toBe(true);
  });

  it("通配符环境命中具体子域（含非默认端口）", () => {
    expect(
      originMatches(
        "http://*.dev.example.com:16800",
        "http://app.dev.example.com:16800/app/#/index",
      ),
    ).toBe(true);
  });

  it("通配符环境不接受端口不一致的具体子域", () => {
    expect(
      originMatches(
        "http://*.dev.example.com:16800",
        "http://app.dev.example.com:16801/app/#/index",
      ),
    ).toBe(false);
  });

  it("通配符环境不接受裸域名", () => {
    expect(
      originMatches("https://*.example.com", "https://example.com/home"),
    ).toBe(false);
  });

  it("单层通配符不接受多级子域", () => {
    expect(
      originMatches("https://*.example.com", "https://a.b.example.com/home"),
    ).toBe(false);
  });

  it("多层通配符按层数匹配", () => {
    expect(
      originMatches("https://*.*.example.com", "https://a.b.example.com/home"),
    ).toBe(true);
    expect(
      originMatches("https://*.*.example.com", "https://a.example.com/home"),
    ).toBe(false);
  });

  it("不同基域不命中", () => {
    expect(
      originMatches("https://*.example.com", "https://chn.evil.com/home"),
    ).toBe(false);
  });

  it("任一地址非法时返回 false", () => {
    expect(originMatches("https://*.example.com", "not-a-url")).toBe(false);
    expect(originMatches("not-a-url", "https://app.example.com")).toBe(false);
  });
});
