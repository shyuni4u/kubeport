import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

const template = readFileSync("../deploy/helm/kubeport/files/dex-password.html", "utf8");
const script = template.match(/<script>([\s\S]*?)<\/script>/)![1];

afterEach(() => {
  document.body.innerHTML = "";
  history.replaceState(null, "", "/");
});

describe("Dex password template", () => {
  it.each(["demo-admin@demo.kubeport", "demo-user@demo.kubeport", "demo+custom@example.com"])("prefills %s and focuses only the password", (email) => {
    document.body.innerHTML = '<input id="login"><input id="password" type="password">';
    history.replaceState(null, "", `/auth/local?state=abc#${new URLSearchParams({ login_hint: email })}`);
    new Function(script)();
    expect((document.getElementById("login") as HTMLInputElement).value).toBe(email);
    expect(document.activeElement).toBe(document.getElementById("password"));
    expect((document.getElementById("password") as HTMLInputElement).value).toBe("");
    expect(location.hash).toBe("");
    expect(location.search).toBe("?state=abc");
  });

  it("preserves the submitted account after an invalid password", () => {
    document.body.innerHTML = '<input id="login" value="edited@example.com"><input id="password" type="password">';
    history.replaceState(null, "", "/#login_hint=demo-user%40demo.kubeport");
    new Function(script)();
    expect((document.getElementById("login") as HTMLInputElement).value).toBe("edited@example.com");
  });

  it("leaves ordinary login alone without a hint", () => {
    document.body.innerHTML = '<input id="login"><input id="password" type="password">';
    new Function(script)();
    expect((document.getElementById("login") as HTMLInputElement).value).toBe("");
  });
});
