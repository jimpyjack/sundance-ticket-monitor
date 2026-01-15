import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const AUTO_PURCHASE_PATH = resolve('./auto-purchase.json');
const BUTTON_SELECTOR = 'button, [role="button"], a, input[type="button"], input[type="submit"]';

const TEXT_PATTERNS = {
  orderTickets: [/order\s+tickets?/i, /get\s+tickets?/i, /buy\s+tickets?/i],
  buyAdditional: [/buy\s+additional\s+tickets/i, /buy\s+additional/i, /add\s+tickets?/i, /add\s+another/i],
  continue: [/add\s+to\s+cart/i, /continue/i, /next/i, /checkout/i, /proceed/i, /review/i],
  final: [/complete\s+purchase/i, /place\s+order/i, /confirm\s+purchase/i, /pay\s+now/i, /submit\s+order/i, /buy\s+now/i, /finish/i]
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

// Get auto-purchase settings for a specific film screening
export function getFilmSettings(filmTitle, screeningTime, config) {
  if (!config || !config.films) return null;

  const normalizedTitle = normalizeTitle(filmTitle);
  const normalizedTime = normalizeTitle(screeningTime || '');

  // First, try exact match on both title and screening time
  const exactMatch = config.films.find(f =>
    normalizeTitle(f.title) === normalizedTitle &&
    normalizeTitle(f.screeningTime || '') === normalizedTime
  );
  if (exactMatch) return exactMatch;

  // Fallback: match on title only if no screening time specified in config
  // (for backwards compatibility with old config files that don't have screeningTime)
  const titleOnlyMatch = config.films.find(f =>
    !f.screeningTime && normalizeTitle(f.title) === normalizedTitle
  );
  if (titleOnlyMatch) return titleOnlyMatch;

  return null;
}

// Check if a film screening should be auto-purchased
export function shouldAutoPurchase(filmTitle, screeningTime, config) {
  const film = getFilmSettings(filmTitle, screeningTime, config);
  return film?.autoPurchase === true;
}

async function waitForPageSettled(page, waitMs = 1500) {
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(waitMs);
}

async function clickFirstMatching(context, patterns, label, quiet = false) {
  for (const pattern of patterns) {
    const locator = context.locator(BUTTON_SELECTOR, { hasText: pattern });
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
      if (!quiet) {
        console.log(`   ✓ ${label || 'Clicked'}${text ? `: "${text}"` : ''}`);
      }
      return true;
    }
  }
  return false;
}

async function clickFirstMatchingAnyContext(page, patterns, label, options = {}) {
  const waitMs = options.waitMs || 0;
  const deadline = Date.now() + waitMs;
  const contexts = () => [page, ...page.frames().filter(f => f !== page.mainFrame())];

  while (true) {
    for (const context of contexts()) {
      if (await clickFirstMatching(context, patterns, label, waitMs > 0)) {
        if (waitMs > 0) {
          console.log(`   ✓ ${label || 'Clicked'} (after wait)`);
        }
        return true;
      }
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(500);
  }
  return false;
}

// Click element by searching all text content (for divs, spans, etc.)
async function clickByTextContent(page, searchText, label) {
  const clicked = await page.evaluate((search) => {
    const searchLower = search.toLowerCase();
    const allElements = document.querySelectorAll('*');

    for (const el of allElements) {
      const text = (el.innerText || el.textContent || '').toLowerCase();
      // Check if this element directly contains the text (not just a parent)
      const directText = Array.from(el.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent)
        .join('')
        .toLowerCase();

      if (directText.includes(searchLower) || (text.includes(searchLower) && el.children.length === 0)) {
        // Find clickable ancestor or use the element itself
        const clickable = el.closest('a, button, [role="button"], [onclick]') || el;
        if (clickable.offsetParent !== null) {
          clickable.click();
          return { clicked: true, text: (clickable.innerText || '').trim().substring(0, 50) };
        }
      }
    }
    return { clicked: false };
  }, searchText);

  if (clicked.clicked) {
    console.log(`   ✓ ${label || 'Clicked'}: "${clicked.text}"`);
    return true;
  }
  return false;
}

async function dumpVisibleButtons(page, label = 'Buttons') {
  const items = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]'));
    return buttons
      .map(btn => {
        const text = (btn.innerText || btn.value || '').trim();
        return text;
      })
      .filter(Boolean)
      .slice(0, 20);
  });
  if (items.length > 0) {
    console.log(`   🔎 ${label}: ${items.join(' | ')}`);
  }
}

async function checkTermsCheckboxes(page) {
  const checked = await page.evaluate(() => {
    // Look for checkboxes related to terms/purchasing
    const patterns = [/agree/i, /terms/i, /conditions/i, /policy/i, /purchasing/i];
    const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
    let checkedAny = false;

    boxes.forEach((box) => {
      if (box.disabled) return;

      // Check the label, parent text, or nearby text
      const label = box.closest('label') || (box.id ? document.querySelector(`label[for="${box.id}"]`) : null);
      const parent = box.parentElement;
      const textSources = [
        label?.innerText,
        box.getAttribute('aria-label'),
        parent?.innerText,
        parent?.textContent
      ].filter(Boolean).join(' ').toLowerCase();

      if (patterns.some(p => p.test(textSources))) {
        if (!box.checked) {
          box.click();
          checkedAny = true;
        }
      }
    });

    return checkedAny;
  });

  if (checked) {
    console.log('   ✓ Checked terms/agreement checkbox');
  }
  return checked;
}

async function setTicketQuantity(page, quantity) {
  if (!quantity || quantity <= 1) return false;

  const result = await page.evaluate((desired) => {
    const selects = Array.from(document.querySelectorAll('select'));
    for (const select of selects) {
      const id = (select.id || '').toLowerCase();
      const name = (select.name || '').toLowerCase();
      const className = (select.className || '').toLowerCase();
      if (id.includes('quantity') || name.includes('quantity') || className.includes('quantity')) {
        // Try desired quantity first
        let option = Array.from(select.options).find(o => o.value === String(desired) || o.textContent.trim() === String(desired));

        // If desired quantity isn't available, try progressively lower quantities down to 1
        if (!option) {
          for (let qty = desired - 1; qty >= 1; qty--) {
            option = Array.from(select.options).find(o => o.value === String(qty) || o.textContent.trim() === String(qty));
            if (option) {
              select.value = option.value;
              select.dispatchEvent(new Event('change', { bubbles: true }));
              return { success: true, quantity: qty };
            }
          }
          return { success: false };
        }

        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, quantity: desired };
      }
    }

    const inputs = Array.from(document.querySelectorAll('input[type="number"]'));
    for (const input of inputs) {
      const id = (input.id || '').toLowerCase();
      const name = (input.name || '').toLowerCase();
      if (!id && !name && inputs.length > 1) continue;
      if (id.includes('quantity') || name.includes('quantity') || inputs.length === 1) {
        if (!input.disabled) {
          // Try desired quantity first
          const max = input.max ? parseInt(input.max) : desired;
          const actualQty = Math.min(desired, max);

          // If can't set desired, try progressively lower down to 1
          for (let qty = actualQty; qty >= 1; qty--) {
            input.value = String(qty);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return { success: true, quantity: qty };
          }
        }
      }
    }

    return { success: false };
  }, quantity);

  if (result.success) {
    if (result.quantity < quantity) {
      console.log(`   ⚠️  Only ${result.quantity} ticket(s) available (requested ${quantity})`);
      console.log(`   ✓ Set ticket quantity to ${result.quantity}`);
    } else {
      console.log(`   ✓ Set ticket quantity to ${result.quantity}`);
    }
  }

  return result.success;
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
  // Only check for errors within modals/dialogs, not the background page
  const errorInModal = await page.evaluate(() => {
    // Look for modal/dialog containers
    const modal = document.querySelector('[role="dialog"], .modal, [class*="modal"], [class*="checkout"], [class*="Checkout"]');
    if (!modal) return false;

    const modalText = modal.innerText.toLowerCase();
    const errorPatterns = ['no longer available', 'payment failed', 'declined', 'try again', 'error'];
    return errorPatterns.some(p => modalText.includes(p));
  });
  return errorInModal;
}

async function runCheckoutFlow(page, settings, helpers) {
  const maxSteps = settings.maxSteps || 12;
  const stepWaitMs = settings.stepWaitMs || 1800;
  const waitForBuyAdditionalMs = settings.waitForBuyAdditionalMs || 15000;
  const payment = getPaymentConfig(settings);

  // Step 1: Click "Buy additional tickets..." - it's often a DIV, not a button
  console.log('   Looking for "Buy additional tickets..." dropdown...');
  await page.waitForTimeout(1500); // Wait for dropdown to appear

  // Try text content search first (handles DIV elements)
  let clickedBuyAdditional = await clickByTextContent(page, 'buy additional tickets', 'Buy additional tickets');

  // Fallback to button patterns if text search didn't work
  if (!clickedBuyAdditional) {
    clickedBuyAdditional = await clickFirstMatchingAnyContext(page, TEXT_PATTERNS.buyAdditional, 'Buy additional tickets', {
      waitMs: waitForBuyAdditionalMs
    });
  }

  if (clickedBuyAdditional) {
    await waitForPageSettled(page, stepWaitMs);
    console.log('   Checkout modal should be open...');
  } else {
    console.log('   ⚠️ Could not find "Buy additional tickets..." - may already be in checkout');
  }

  // Main checkout loop - simplified for Sundance flow:
  // 1. Check terms checkbox
  // 2. Click "COMPLETE PURCHASE"
  for (let step = 1; step <= maxSteps; step++) {
    console.log(`   Checkout step ${step}...`);

    // Safety checks
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
      return { success: false, reason: 'Checkout error in modal', url: page.url() };
    }

    let acted = false;

    // Step A: Check the terms checkbox ("I agree to the Purchasing Terms")
    acted = acted || await checkTermsCheckboxes(page);

    // Step B: Try to click "COMPLETE PURCHASE" button
    if (await clickFirstMatchingAnyContext(page, TEXT_PATTERNS.final, 'Complete purchase')) {
      await waitForPageSettled(page, stepWaitMs + 1000); // Extra wait for purchase processing
      if (await detectConfirmation(page)) {
        return { success: true, reason: 'Purchase confirmed', url: page.url() };
      }
      acted = true;
    }

    // Fallback: Try quantity adjustment if needed
    acted = acted || await setTicketQuantity(page, settings.ticketQuantity);

    // Fallback: Try saved payment selection
    acted = acted || await selectSavedPayment(page);

    // Fallback: Try continue/next buttons
    acted = acted || await clickFirstMatchingAnyContext(page, TEXT_PATTERNS.continue, 'Continue');

    if (!acted) {
      if (settings.debugScreenshots || settings.debugButtonDump) {
        await dumpVisibleButtons(page, `Step ${step} - no action taken`);
      }
      // Wait a bit and try one more time in case page is still loading
      await page.waitForTimeout(1500);
      continue;
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

// Attempt to purchase tickets for a specific film screening
export async function attemptPurchase(page, filmTitle, screeningTime, config, sendNotification) {
  console.log(`\n🛒 AUTO-PURCHASE: Starting purchase flow for "${filmTitle}"`);
  if (screeningTime) {
    console.log(`   Screening: ${screeningTime}`);
  }

  const settings = config.settings || {};
  const filmSettings = getFilmSettings(filmTitle, screeningTime, config);

  if (!filmSettings) {
    return { success: false, reason: 'Film screening not found in auto-purchase list' };
  }

  if (filmSettings.autoPurchase !== true) {
    return { success: false, reason: 'Auto-purchase disabled for this screening' };
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
