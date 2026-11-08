
import { extractWebsite } from "./extractor.js";

async function main() {
  const input = process.argv[2];

  if (!input) {
    throw new Error(
      'Usage: npx tsx src/index.ts "https://example.com"'
    );
  }

  const url = new URL(input);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are allowed.");
  }

  console.log(`Extracting: ${url.href}`);

  const result = await extractWebsite(url.href);

  console.log("\nExtraction finished!");
  console.log("Output:", result.outputDirectory);
  console.log("Pages captured:", result.pages.length);
  console.log("Assets saved:", result.assetsSaved);
  console.log("Warnings:", result.warnings.length);
  console.log("Report:", result.reportPath);
}

main().catch((error) => {
  console.error("Extraction failed:", error);
  process.exitCode = 1;
});
