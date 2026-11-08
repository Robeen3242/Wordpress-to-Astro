
import { chromium } from "playwright";

// Launch a visible Chromium browser
const browser = await chromium.launch({
  headless: false,
});

// Open a new browser tab
const page = await browser.newPage();

// Navigate to a website
await page.goto("https://example.com");

const heading = await page.locator("h1").textContent();

console.log("Main heading:", heading);

// Keep the browser open for 10 seconds
await page.waitForTimeout(10000);

// Read the page title
const title: string = await page.title();

console.log("Website title:", title);

// Take a screenshot
await page.screenshot({
  path: "test.png",
});

// Close the browser
await browser.close();
