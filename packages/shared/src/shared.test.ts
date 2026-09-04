import { describe, expect, it } from "vitest";
import { canonicalAccount, classifyTab, serverOrigin } from "./index";

describe("URL policy", () => {
  it.each([
    ["https://example.com", "web"],
    ["http://example.com", "web"],
    ["https://example.com/report.pdf?x=1", "remote-pdf-as-web"],
    ["chrome://newtab/", "newtab"],
    ["helium://newtab/", "newtab"],
    ["about:blank", "newtab"],
    ["file:///C:/private/document.pdf", "local-file"],
    ["chrome://settings", "browser-internal"],
    ["helium://settings", "browser-internal"],
    ["chrome-extension://other/page.html", "extension-page"],
    ["devtools://devtools/", "devtools"],
    ["data:text/plain,secret", "data"],
    ["blob:https://example.com/id", "blob"],
    ["javascript:alert(1)", "other-protected"],
  ])("classifies %s without copying protected content", (url, kind) => {
    const result = classifyTab(url);
    expect(result?.kind).toBe(kind);
    if (!["web", "remote-pdf-as-web"].includes(kind)) expect(result).not.toHaveProperty("url");
  });
  it("excludes incognito and Relay-owned UI", () => {
    expect(classifyTab("https://example.com", true)).toBeNull();
    expect(
      classifyTab(
        "chrome-extension://relay/placeholder.html#id",
        false,
        "chrome-extension://relay",
      ),
    ).toBeNull();
  });
  it("validates account and custom-server boundaries", () => {
    expect(() => serverOrigin("https://*", false)).toThrow();
    expect(() => canonicalAccount("123")).toThrow();
    expect(() => serverOrigin("http://example.com", true)).toThrow();
    expect(() => serverOrigin("http://localhost:8787", false)).toThrow();
    expect(serverOrigin("http://localhost:8787", true)).toBe("http://localhost:8787");
    expect(serverOrigin("http://10.0.0.12:8787", true)).toBe("http://10.0.0.12:8787");
    expect(serverOrigin("http://172.16.0.1", true)).toBe("http://172.16.0.1");
    expect(serverOrigin("http://172.31.255.255", true)).toBe("http://172.31.255.255");
    expect(serverOrigin("http://192.168.1.1", true)).toBe("http://192.168.1.1");
    expect(() => serverOrigin("http://172.15.0.1", true)).toThrow();
    expect(() => serverOrigin("http://172.32.0.1", true)).toThrow();
    expect(() => serverOrigin("https://user:pass@example.com", false)).toThrow();
  });
});
