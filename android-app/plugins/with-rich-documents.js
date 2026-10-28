const { withAppBuildGradle } = require("@expo/config-plugins");
function enableRichDocuments(contents) {
  if (!contents.includes("// Lumen rich documents: Java API compatibility")) {
    if (!/android\s*\{/.test(contents) || !/dependencies\s*\{/.test(contents))
      throw Error("Cannot locate Android Gradle sections");
    contents = contents.replace(
      /android\s*\{/,
      "android {\n    // Lumen rich documents: Java API compatibility\n    compileOptions { coreLibraryDesugaringEnabled true }",
    );
    contents = contents.replace(
      /dependencies\s*\{/,
      'dependencies {\n    coreLibraryDesugaring "com.android.tools:desugar_jdk_libs:2.1.5"',
    );
  }
  return contents;
}
module.exports = (config) =>
  withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== "groovy")
      throw Error("Lumen requires Groovy Android config");
    cfg.modResults.contents = enableRichDocuments(cfg.modResults.contents);
    return cfg;
  });
module.exports.enableRichDocuments = enableRichDocuments;
