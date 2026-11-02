import { describe, expect, it } from "vitest";
import { href, parse } from "@/lib/hooks";

describe("hash routes", () => {
  it("reads the address an access request asks to invite, and writes it back", () => {
    expect(parse("#/access?invite=new%2Beval%40gmail.com")).toEqual({ page: "access", invite: "new+eval@gmail.com" });
    expect(parse("#/access")).toEqual({ page: "access" });
    expect(parse("#/access?invite=")).toEqual({ page: "access" });
    expect(href({ page: "access", invite: "a+b@c.io" })).toBe("#/access?invite=a%2Bb%40c.io");
    expect(parse(href({ page: "access", invite: "a+b@c.io" }))).toEqual({ page: "access", invite: "a+b@c.io" });
  });
});
