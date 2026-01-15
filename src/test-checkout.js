import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { attemptPurchase } from './auto-purchase.js';

const SCHEDULE_URL = 'https://festival.sundance.org/my-festival/my-schedule';
const COOKIES_PATH = resolve('./cookies.json');

async function testCheckout() {
  const filmTitle = process.env.FILM_TITLE || process.argv.slice(2).join(' ').trim();
  if (!filmTitle) {
    console.log('❌ Missing film title.');
    console.log('Usage: FILM_TITLE="Your Film" bun run test-checkout');
    console.log('   or: bun run test-checkout "Your Film"');
    process.exit(1);
  }

  if (!existsSync(COOKIES_PATH)) {
    console.error('❌ cookies.json not found!');
    process.exit(1);
  }

  const cookies = JSON.parse(readFileSync(COOKIES_PATH, 'utf-8'));

  console.log(`🧪 Checkout test for: "${filmTitle}"`);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  await context.addCookies(cookies);
  const page = await context.newPage();

  try {
    console.log('📍 Loading main page...');
    await page.goto('https://festival.sundance.org/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    console.log('📍 Loading schedule page...');
    await page.goto(SCHEDULE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('.sd_schedule_film_desc', { timeout: 30000 });
    await page.waitForTimeout(3000);

    const config = {
      enabled: true,
      films: [{ title: filmTitle, autoPurchase: true }],
      settings: {
        ticketQuantity: parseInt(process.env.TICKET_QTY || '1', 10),
        debugScreenshots: true,
        keepCheckoutOpen: true,
        maxSteps: parseInt(process.env.MAX_STEPS || '12', 10),
        stepWaitMs: parseInt(process.env.STEP_WAIT_MS || '1800', 10)
      }
    };

    const result = await attemptPurchase(page, filmTitle, config, null);
    console.log(`\nResult: ${result.success ? 'SUCCESS' : 'FAILED'} - ${result.reason}`);
    if (result.url) {
      console.log(`URL: ${result.url}`);
    }

    console.log('\nBrowser will stay open for 20 seconds for inspection.');
    await page.waitForTimeout(20000);
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await browser.close();
  }
}

testCheckout().catch(console.error);
