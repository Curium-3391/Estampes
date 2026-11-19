// The test suite describes the zh-TW interface (the language the existing
// tests assert), so every test process and every server it spawns runs with
// ESTAMPES_DEFAULT_LOCALE=zh-TW whatever the developer's shell says. Tests
// for other languages set the locale explicitly. `npm test` and
// scripts/run-ci-tests.mjs load this file with --import.
process.env.ESTAMPES_DEFAULT_LOCALE = "zh-TW";
delete process.env.ESTAMPES_LOCALE_FROM_HOST;
