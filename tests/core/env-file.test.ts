import { describe, expect, it } from "vitest";
import { parseEnvAssignment, parseEnvFile } from "../../src/core/env-file.js";

describe("parseEnvFile", () => {
  it("parses compose-style entries and ignores comments/invalid lines", () => {
    expect(
      parseEnvFile(
        "# comment\n\nA=one\nB = \"two words\"\nC='three'\nNO_EQUALS\nA=last\n",
      ),
    ).toEqual({ A: "last", B: "two words", C: "three" });
  });

  it.each([
    ["FOO=bar", { name: "FOO", value: "bar" }],
    ['FOO="bar baz"', { name: "FOO", value: "bar baz" }],
    ["FOO='bar'", { name: "FOO", value: "bar" }],
  ])("parses shorthand assignment %s", (entry, expected) => {
    expect(parseEnvAssignment(entry)).toEqual(expected);
  });

  it("rejects assignments without a key or equals sign", () => {
    expect(parseEnvAssignment("NO_EQUALS")).toBeUndefined();
    expect(parseEnvAssignment("=value")).toBeUndefined();
  });
});
