import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const COOKIES_PATH = resolve('./cookies.json');
const OUTPUT_PATH = resolve('./auto-purchase.json');
const SCHEDULE_URL = 'https://festival.sundance.org/my-festival/my-schedule';

async function loadCookies() {
  if (!existsSync(COOKIES_PATH)) {
    throw new Error('cookies.json not found. Please export your Sundance cookies first.');
  }
  const cookiesJson = readFileSync(COOKIES_PATH, 'utf-8');
  return JSON.parse(cookiesJson);
}

// No longer needed - we want to keep all screenings, even duplicates of the same film

async function scrollSchedule(page) {
  let lastHeight = await page.evaluate(() => document.body.scrollHeight);
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => {
      const el = document.scrollingElement || document.body;
      el.scrollBy(0, window.innerHeight);
    });
    await page.waitForTimeout(800);
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === lastHeight) break;
    lastHeight = newHeight;
  }
}

async function scrapeScheduleScreenings(page) {
  // Load main page first to establish session (mirrors monitor.js)
  await page.goto('https://festival.sundance.org/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  const start = Date.now();
  await page.goto(SCHEDULE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Wait for schedule rows to appear
  try {
    await page.waitForSelector('.sd_schedule_film_desc', { timeout: 30000 });
  } catch (err) {
    console.warn('⚠️  Could not find .sd_schedule_film_desc; taking screenshot for debugging.');
    await page.screenshot({ path: 'generate-auto-purchase-missing-selector.png', fullPage: true }).catch(() => {});
  }

  // Try to force-load all rows (handles virtualized tables)
  await scrollSchedule(page);

  // Extract titles AND screening times (matches monitor.js extraction logic)
  const screenings = await page.evaluate(() => {
    const out = [];
    const descs = Array.from(document.querySelectorAll('.sd_schedule_film_desc'));
    descs.forEach((desc) => {
      const h3 = desc.querySelector('h3');
      if (!h3) return;

      const title = h3.textContent.trim();
      if (!title || title.length < 2) return;

      // Get screening time from date element (same as monitor.js)
      const dateElement = desc.querySelector('.sd_start_end_date');
      const screeningTime = dateElement ? dateElement.textContent.trim().replace(/\s+/g, ' ') : '';

      out.push({ title, screeningTime });
    });
    return out;
  });

  const duration = Math.round((Date.now() - start) / 1000);
  console.log(`   ⏱️  Schedule load + scrape took ${duration}s`);

  return screenings;
}

async function main() {
  if (existsSync(OUTPUT_PATH)) {
    console.log(`ℹ️  ${OUTPUT_PATH} already exists. Delete or rename it if you want to regenerate.`);
    return;
  }

  const cookies = await loadCookies();

  console.log('🎬 Loading schedule to build auto-purchase list...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addCookies(cookies);
  const page = await context.newPage();

  const screenings = await scrapeScheduleScreenings(page);
  await browser.close();

  if (screenings.length === 0) {
    console.log('❌ No screenings found on your schedule. Add films to your schedule first.');
    return;
  }

  // Keep each screening separate - don't deduplicate
  const films = screenings.map((screening) => ({
    title: screening.title,
    screeningTime: screening.screeningTime,
    autoPurchase: false
  }));

  const config = {
    enabled: true,
    films,
    settings: {
      ticketQuantity: 1,
      notifyOnPurchaseUpdates: true,
      debugScreenshots: false
    }
  };

  writeFileSync(OUTPUT_PATH, JSON.stringify(config, null, 2));
  console.log(`✅ auto-purchase.json created with ${films.length} screening(s).`);
  console.log('   Each screening is listed separately by time.');
  console.log('   Set autoPurchase: true for the specific screenings you want to buy automatically.');
}

main().catch((err) => {
  console.error('❌ Failed to generate auto-purchase.json:', err.message);
  process.exit(1);
});
