#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const LOCALES_DIR = path.join(__dirname, "..", "client", "src", "i18n", "locales");
const REFERENCE_LANG = "en";

function flattenKeys(obj, prefix = "") {
  const keys = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null) {
      keys.push(...flattenKeys(value, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

function getNamespaces(langDir) {
  return fs
    .readdirSync(langDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(".json", ""));
}

const refDir = path.join(LOCALES_DIR, REFERENCE_LANG);
const namespaces = getNamespaces(refDir);
const langs = fs
  .readdirSync(LOCALES_DIR)
  .filter(
    (d) =>
      d !== REFERENCE_LANG &&
      fs.statSync(path.join(LOCALES_DIR, d)).isDirectory(),
  );

let hasErrors = false;
let totalMissing = 0;

for (const lang of langs) {
  const langDir = path.join(LOCALES_DIR, lang);

  for (const ns of namespaces) {
    const refFile = path.join(refDir, `${ns}.json`);
    const langFile = path.join(langDir, `${ns}.json`);

    if (!fs.existsSync(langFile)) {
      console.error(`MISSING: ${lang}/${ns}.json does not exist`);
      hasErrors = true;
      continue;
    }

    const refData = JSON.parse(fs.readFileSync(refFile, "utf-8"));
    const langData = JSON.parse(fs.readFileSync(langFile, "utf-8"));

    const refKeys = flattenKeys(refData);
    const langKeys = flattenKeys(langData);

    const missing = refKeys.filter((k) => !langKeys.includes(k));
    const extra = langKeys.filter((k) => !refKeys.includes(k));

    if (missing.length > 0) {
      console.warn(`WARN: ${lang}/${ns}.json missing ${missing.length} keys: ${missing.join(", ")}`);
      totalMissing += missing.length;
    }
    if (extra.length > 0) {
      console.warn(`EXTRA in ${lang}/${ns}.json: ${extra.join(", ")}`);
    }
  }

  const langNs = getNamespaces(langDir);
  const missingNs = namespaces.filter((ns) => !langNs.includes(ns));
  if (missingNs.length > 0) {
    console.error(`MISSING namespaces in ${lang}/: ${missingNs.join(", ")}`);
    hasErrors = true;
  }
}

if (hasErrors) {
  console.error("\ni18n completeness check FAILED (missing namespace files)");
  process.exit(1);
} else if (totalMissing > 0) {
  console.warn(
    `\ni18n completeness check PASSED with warnings (${totalMissing} missing keys across ${langs.length} locales, ${namespaces.length} namespaces)`,
  );
} else {
  console.log(
    `i18n completeness check PASSED (${langs.length} locales, ${namespaces.length} namespaces)`,
  );
}
