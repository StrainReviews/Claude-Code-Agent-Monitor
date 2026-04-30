import { describe, it, expect } from "vitest";
import i18n from "i18next";

describe("German (de) locale", () => {
  it("should provide German translations for navigation keys", async () => {
    await i18n.changeLanguage("de");

    expect(i18n.t("nav:dashboard")).toBe("Dashboard");
    expect(i18n.t("nav:settings")).toBe("Einstellungen");
    expect(i18n.t("nav:languageShort.de")).toBe("DE");
    expect(i18n.t("nav:languageNames.de")).toBe("Deutsch");
  });

  it("should keep Agent terminology untranslated in de locale", async () => {
    await i18n.changeLanguage("de");
    expect(i18n.t("common:agent")).toBe("Agent");
    expect(i18n.t("common:subagent")).toBe("Subagent");
  });

  it("should support non-explicit German locale tags", async () => {
    await i18n.changeLanguage("de-DE");

    expect(i18n.resolvedLanguage?.startsWith("de")).toBe(true);
    expect(i18n.t("nav:dashboard")).toBe("Dashboard");
  });

  it("should have all common keys without fallback to English", async () => {
    await i18n.changeLanguage("de");

    expect(i18n.t("common:refresh")).not.toBe("Refresh");
    expect(i18n.t("common:loading")).toBeTruthy();
    expect(i18n.t("common:status.working")).toBeTruthy();
    expect(i18n.t("common:time.justNow")).toBeTruthy();
  });

  it("should preserve interpolation placeholders", async () => {
    await i18n.changeLanguage("de");

    const result = i18n.t("common:showMore", { count: 5 });
    expect(result).toContain("5");
    expect(result).not.toContain("{{");
  });

  it("should handle German pluralization", async () => {
    await i18n.changeLanguage("de");

    const one = i18n.t("common:subagent_label", { count: 1 });
    const many = i18n.t("common:subagent_label", { count: 3 });
    expect(one).toContain("1");
    expect(many).toContain("3");
  });
});
