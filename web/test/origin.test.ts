import { describe, expect, it } from "vitest";
import { movedTo } from "../src/lib/api";

const at = (url: string) => {
  const u = new URL(url);
  return { origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash };
};

describe("movedTo", () => {
  it("sends an old preview link to the page's own address, same view", () => {
    expect(movedTo("https://eval.example", at("https://abc.preview.example/?run=r1#/runs/r1"))).toBe("https://eval.example/?run=r1#/runs/r1");
  });
  it("stays put at the page's own address, locally, and on a plain-http origin", () => {
    expect(movedTo("https://eval.example", at("https://eval.example/#/"))).toBeNull();
    expect(movedTo("https://Eval.example/", at("https://eval.example/#/"))).toBeNull(); // written another way, the same origin
    expect(movedTo("not an origin", at("https://eval.example/"))).toBeNull();
    expect(movedTo(null, at("http://127.0.0.1:8765/"))).toBeNull();
    expect(movedTo(undefined, at("http://127.0.0.1:8765/"))).toBeNull();
    expect(movedTo("http://127.0.0.1:8799", at("http://localhost:8799/"))).toBeNull();
  });
});
