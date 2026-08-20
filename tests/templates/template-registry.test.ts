import { describe, expect, it } from "vitest";
import {
  getTemplate,
  templates,
} from "../../src/templates/template-registry.js";

describe("template-registry", () => {
  it("exports goal and blueprint templates", () => {
    expect(templates.goal).toBeDefined();
    expect(templates.blueprint).toBeDefined();
    expect(templates.goal["ralph.yaml"]).toContain("schemaVersion: 1");
    expect(templates.blueprint["ralph.yaml"]).toContain("schemaVersion: 1");
  });

  it("retrieves template by name case-insensitively", () => {
    expect(getTemplate("goal")).toBe(templates.goal);
    expect(getTemplate("GOAL")).toBe(templates.goal);
    expect(getTemplate("blueprint")).toBe(templates.blueprint);
    expect(getTemplate("BLUEPRINT")).toBe(templates.blueprint);
  });

  it("returns undefined for unknown template names", () => {
    expect(getTemplate("unknown")).toBeUndefined();
    expect(getTemplate("")).toBeUndefined();
  });
});
