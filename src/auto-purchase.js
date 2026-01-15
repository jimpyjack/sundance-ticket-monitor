import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const AUTO_PURCHASE_PATH = resolve('./auto-purchase.json');
const BUTTON_SELECTOR = 'button, [role="button"], a, input[type="button"], input[type="submit"]';

const TEXT_PATTERNS = {
  orderTickets: [/order\s+tickets?/i, /get\s+tickets?/i, /buy\s+tickets?/i],
  buyAdditional: [/buy\s+additional/i, /add\s+tickets?/i, /add\s+another/i],
  continue: [/add\s+to\s+cart/i, /continue/i, /next/i, /checkout/i, /proceed/i, /review/i],
  final: [/complete\s+purchase/i, /place\s+order/i, /confirm\s+purchase/i, /pay\s+now/i, /submit\s+order/i, /buy\s+now/i]
};

function normalizeTitle(title) {
  return (title || '').toLowerCase().trim();
}

function slugify(title) {
  return normalizeTitle(title).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

function getPaymentConfig(settings = {}) {
  const payment = settings.payment || {};
  return {
    cardNumber: payment.cardNumber || process.env.SUNDANCE_CARD_NUMBER,
    exp: payment.exp || process.env.SUNDANCE_CARD_EXP,
    cvc: payment.cvc || process.env.SUNDANCE_CARD_CVC,
    name: payment.name || process.env.SUNDANCE_CARD_NAME,
    zip: payment.zip || process.env.SUNDANCE_BILLING_ZIP || process.env.SUNDANCE_BILLING_POSTAL
  };
}

// Load auto-purchase configuration
export function loadAutoPurchaseConfig() {
  if (!existsSync(AUTO_PURCHASE_PATH)) {
    return null;
  }

  try {
    const config = JSON.parse(readFileSync(AUTO_PURCHASE_PATH, 'utf-8'));
    if (!config.enabled) {
      return null;
    }
    return config;
  } catch (error) {
    console.error('⚠️  Error loading auto-purchase.json:', error.message);
    return null;
  }
}

// Get auto-purchase settings for a specific film
export function getFilmSettings(filmTitle, config) {
  if (!config || !config.films) return null;

  const normalized = normalizeTitle(filmTitle);
  const exact = config.films.find(f => normalizeTitle(f.title) === normalized);
  if (exact) return exact;

  return config.films.find(f =>
    normalized.includes(normalizeTitle(f.title)) ||
    normalizeTitle(f.title).includes(normalized)
  ) || null;
}

// Check if a film should be auto-purchased
export function shouldAutoPurchase(filmTitle, config) {
  const film = getFilmSettings(filmTitle, config);
  return film?.autoPurchase === true;
}

async function waitForPageSettled(page, waitMs = 1500) {
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(waitMs);
}

async function clickFirstMatching(page, patterns, label) {
  for (const pattern of patterns) {
    const locator = page.locator(BUTTON_SELECTOR, { hasText: pattern });
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 6); i++) {
      const target = locator.nth(i);
      const visible = await target.isVisible().catch(() => false);
      if (!visible) continue;
      const disabled = await target.isDisabled().catch(() => false);
      if (disabled) continue;
      const text = (await target.innerText().catch(() => '')).trim();
      if (text && /sold\s*out/i.test(text)) continue;
      await target.click({ timeout: 5000 });
      console.log(`   ✓ ${label || 'Clicked'}${text ? `: "${text}"` : ''}`);
      return true;
    }
  }
  return false;
}

async function checkTermsCheckboxes(page) {
  return await page.evaluate(() => {
    const patterns = [/agree/i, /terms/i, /conditions/i, /policy/i];
    const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
    let checkedAny = false;

    boxes.forEach((box) => {
      if (box.disabled) return;
      const label = box.closest('label') || (box.id ? document.querySelector(`label[for="${box.id}"]`) : null);
      const labelText = (label?.innerText || box.getAttribute('aria-label') || '').toLowerCase();
      if (patterns.some(p => p.test(labelText))) {
        if (!box.checked) {
          box.click();
          checkedAny = true;
        }
      }
    });

    return checkedAny;
  });
}

async function setTicketQuantity(page, quantity) {
  if (!quantity || quantity <= 1) return false;

  const updated = await page.evaluate((desired) => {
    const selects = Array.from(document.querySelectorAll('select'));
    for (const select of selects) {
      const id = (select.id || '').toLowerCase();
      const name = (select.name || '').toLowerCase();
      const className = (select.className || '').toLowerCase();
      if (id.includes('quantity') || name.includes('quantity') || className.includes('quantity')) {
        const option = Array.from(select.options).find(o => o.value === String(desired) || o.textContent.trim() === String(desired));
        if (option) {
          select.value = option.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
    }

    const inputs = Array.from(document.querySelectorAll('input[type="number"]'));
    for (const input of inputs) {
      const id = (input.id || '').toLowerCase();
      const name = (input.name || '').toLowerCase();
      if (!id && !name && inputs.length > 1) continue;
      if (id.includes('quantity') || name.includes('quantity') || inputs.length === 1) {
        if (!input.disabled) {
          input.value = String(desired);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
    }

    return false;
  }, quantity);

  if (updated) {
    console.log(`   ✓ Set ticket quantity to ${quantity}`);
  }

  return updated;
}

async function selectSavedPayment(page) {
  return await page.evaluate(() => {
    const patterns = ['VISA', 'MASTERCARD', 'AMEX', 'AMERICAN EXPRESS', 'DISCOVER', 'ENDING', '****', 'CARD'];
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    for (const radio of radios) {
      if (radio.disabled) continue;
      const label = radio.closest('label') || (radio.id ? document.querySelector(`label[for="${radio.id}"]`) : null);
      const labelText = (label?.innerText || radio.getAttribute('aria-label') || '').toUpperCase();
      if (patterns.some(p => labelText.includes(p))) {
        if (!radio.checked) {
          radio.click();
        }
        return true;
      }
    }
    return false;
  });
}

async function fillInputs(frame, selectors, value) {
  for (const selector of selectors) {
    const locator = frame.locator(selector);
    const count = await locator.count().catch(() => 0);
    if (count === 0) continue;
    const field = locator.first();
    const visible = await field.isVisible().catch(() => false);
    if (!visible) continue;
    await field.fill(value, { timeout: 5000 }).catch(() => {});
    return true;
  }
  return false;
}

async function fillCardDetails(page, payment) {
  if (!payment.cardNumber && !payment.exp && !payment.cvc) return false;

  let filledAny = false;
  const frames = page.frames();

  for (const frame of frames) {
    if (payment.cardNumber) {
      const filled = await fillInputs(frame, [
        'input[name="cardnumber"]',
        'input[autocomplete="cc-number"]',
        'input[aria-label*="Card number"]',
        'input[placeholder*="Card number"]',
        'input[placeholder*="Card Number"]'
      ], payment.cardNumber);
      filledAny = filledAny || filled;
    }
    if (payment.exp) {
      const filled = await fillInputs(frame, [
        'input[name="exp-date"]',
        'input[autocomplete="cc-exp"]',
        'input[aria-label*="Expiry"]',
        'input[aria-label*="Expiration"]',
        'input[placeholder*="MM"]',
        'input[placeholder*="MM/YY"]'
      ], payment.exp);
      filledAny = filledAny || filled;
    }
    if (payment.cvc) {
      const filled = await fillInputs(frame, [
        'input[name="cvc"]',
        'input[name="cvv"]',
        'input[autocomplete="cc-csc"]',
        'input[aria-label*="CVC"]',
        'input[aria-label*="CVV"]',
        'input[placeholder*="CVC"]'
      ], payment.cvc);
      filledAny = filledAny || filled;
    }
  }

  // Name/zip usually live in main frame
  if (payment.name) {
    const filled = await fillInputs(page, [
      'input[name*="name"]',
      'input[autocomplete="cc-name"]',
      'input[aria-label*="Name on card"]',
      'input[placeholder*="Name"]'
    ], payment.name);
    filledAny = filledAny || filled;
  }
  if (payment.zip) {
    const filled = await fillInputs(page, [
      'input[name*="zip"]',
      'input[name*="postal"]',
      'input[autocomplete="postal-code"]',
      'input[aria-label*="ZIP"]',
      'input[placeholder*="ZIP"]',
      'input[placeholder*="Postal"]'
    ], payment.zip);
    filledAny = filledAny || filled;
  }

  if (filledAny) {
    console.log('   ✓ Filled payment fields');
  }
  return filledAny;
}

async function detectLogin(page) {
  const url = page.url();
  if (/login|sign-in|signin|auth/i.test(url)) return true;
  const hasPassword = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
  if (hasPassword) return true;
  const hasLoginText = await page.locator('text=/sign in|log in/i').first().isVisible().catch(() => false);
  return hasLoginText;
}

async function detectQueue(page) {
  const url = page.url();
  if (/queue|waiting-room/i.test(url)) return true;
  const hasQueueText = await page.locator('text=/waiting room|queue/i').first().isVisible().catch(() => false);
  return hasQueueText;
}

async function detectConfirmation(page) {
  const url = page.url();
  if (/confirmation|receipt|thank-you|order-complete|purchase-complete/i.test(url)) return true;
  const confirmationText = await page.locator('text=/thank you|order confirmed|purchase complete|confirmation number|receipt/i')
    .first()
    .isVisible()
    .catch(() => false);
  return confirmationText;
}

async function detectBlockingError(page) {
  const errorText = await page.locator('text=/sold out|no longer available|payment failed|declined|try again/i')
    .first()
    .isVisible()
    .catch(() => false);
  return errorText;
}

async function runCheckoutFlow(page, settings, helpers) {
  const maxSteps = settings.maxSteps || 12;
  const stepWaitMs = settings.stepWaitMs || 1800;
  const payment = getPaymentConfig(settings);

  for (let step = 1; step <= maxSteps; step++) {
    if (await detectQueue(page)) {
      return { success: false, reason: 'Queue/waiting room encountered', url: page.url() };
    }
    if (await detectLogin(page)) {
      return { success: false, reason: 'Login required during checkout', url: page.url() };
    }
    if (await detectConfirmation(page)) {
      return { success: true, reason: 'Purchase confirmed', url: page.url() };
    }
    if (await detectBlockingError(page)) {
      return { success: false, reason: 'Checkout error or sold out', url: page.url() };
    }

    let acted = false;

    // Some flows require "Buy additional tickets" before quantity selection
    acted = acted || await clickFirstMatching(page, TEXT_PATTERNS.buyAdditional, 'Buy additional tickets');

    // Quantity
    acted = acted || await setTicketQuantity(page, settings.ticketQuantity);

    // Terms checkbox
    acted = acted || await checkTermsCheckboxes(page);

    // Payment selection / entry
    acted = acted || await selectSavedPayment(page);
    acted = acted || await fillCardDetails(page, payment);

    // Final confirmation
    if (await clickFirstMatching(page, TEXT_PATTERNS.final, 'Complete purchase')) {
      await waitForPageSettled(page, stepWaitMs);
      if (await detectConfirmation(page)) {
        return { success: true, reason: 'Purchase confirmed', url: page.url() };
      }
      acted = true;
    }

    // Continue through flow
    acted = acted || await clickFirstMatching(page, TEXT_PATTERNS.continue, 'Continue');

    if (!acted) {
      break;
    }

    await waitForPageSettled(page, stepWaitMs);
    if (helpers?.debug && helpers?.screenshot) {
      await helpers.screenshot(`step-${step}`);
    }
  }

  return { success: false, reason: 'Checkout flow incomplete', url: page.url() };
}

async function clickOrderTicketsButton(page, filmTitle) {
  const found = await page.evaluate((title) => {
    const filmDescs = Array.from(document.querySelectorAll('.sd_schedule_film_desc'));
    for (const desc of filmDescs) {
      const titleEl = desc.querySelector('h3');
      if (!titleEl) continue;
      const filmTitle = titleEl.textContent.trim();
      if (!filmTitle.toLowerCase().includes(title.toLowerCase())) continue;

      const row = desc.closest('.rdt_TableRow, [class*="TableRow"]');
      if (!row) continue;

      const buttons = row.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]');
      for (const btn of buttons) {
        const text = btn.textContent.trim().toUpperCase();
        if (text.includes('ORDER') || text.includes('GET') || (text.includes('BUY') && text.includes('TICKET'))) {
          btn.setAttribute('data-auto-purchase-target', 'true');
          return true;
        }
      }
    }
    return false;
  }, filmTitle);

  if (!found) {
    return { success: false, reason: 'Order tickets button not found' };
  }

  const popupPromise = page.context().waitForEvent('page', { timeout: 8000 }).catch(() => null);
  await page.click('[data-auto-purchase-target="true"]');
  const popup = await popupPromise;

  const purchasePage = popup || page;
  if (popup) {
    await purchasePage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  }

  return { success: true, purchasePage, openedNewPage: !!popup };
}

// Attempt to purchase tickets for a film
export async function attemptPurchase(page, filmTitle, config, sendNotification) {
  console.log(`\n🛒 AUTO-PURCHASE: Starting purchase flow for "${filmTitle}"`);

  const settings = config.settings || {};
  const filmSettings = getFilmSettings(filmTitle, config);

  if (!filmSettings) {
    return { success: false, reason: 'Film not found in auto-purchase list' };
  }

  if (filmSettings.autoPurchase !== true) {
    return { success: false, reason: 'Auto-purchase disabled for this film' };
  }

  const runId = Date.now();
  const slug = slugify(filmTitle) || 'film';
  const debug = settings.debugScreenshots === true;

  let currentPage = page;
  const screenshot = async (label) => {
    if (!debug) return;
    const path = `auto-purchase-${slug}-${runId}-${label}.png`;
    await currentPage.screenshot({ path, fullPage: true }).catch(() => {});
  };

  try {
    // Step 1: Find and click the "Order tickets" button for this film
    console.log('   Step 1: Finding Order tickets button...');
    const orderResult = await clickOrderTicketsButton(page, filmTitle);
    if (!orderResult.success) {
      return { success: false, reason: orderResult.reason };
    }

    const purchasePage = orderResult.purchasePage;
    currentPage = purchasePage;
    await waitForPageSettled(purchasePage);
    await screenshot('after-order');

    console.log('   Step 2+: Navigating checkout flow...');
    const checkoutResult = await runCheckoutFlow(purchasePage, settings, { debug, screenshot });

    if (orderResult.openedNewPage && purchasePage !== page && settings.keepCheckoutOpen !== true) {
      await purchasePage.close().catch(() => {});
    }

    if (sendNotification && settings.notifyOnPurchaseUpdates !== false) {
      const change = {
        type: checkoutResult.success ? 'PURCHASE_SUCCESS' : 'PURCHASE_FAILED',
        title: filmTitle,
        screeningTime: '',
        buttonText: checkoutResult.reason,
        url: checkoutResult.url || purchasePage.url()
      };
      await sendNotification([change]);
    }

    return checkoutResult;
  } catch (error) {
    console.error(`   ❌ Auto-purchase error: ${error.message}`);
    try {
      await currentPage.screenshot({ path: `auto-purchase-error-${runId}.png`, fullPage: true });
    } catch (e) {
      // Ignore screenshot errors
    }
    return { success: false, reason: error.message };
  }
}
