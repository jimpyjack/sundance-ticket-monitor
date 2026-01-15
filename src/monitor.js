import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { Resend } from 'resend';
import { loadAutoPurchaseConfig, shouldAutoPurchase, attemptPurchase } from './auto-purchase.js';

const SCHEDULE_URL = 'https://festival.sundance.org/my-festival/my-schedule';
const COOKIES_PATH = resolve('./cookies.json');
const STATE_PATH = resolve('./ticket-state.json');
const CHECK_INTERVAL = process.env.CHECK_INTERVAL ? parseInt(process.env.CHECK_INTERVAL) : 60000;

// Email configuration (optional)
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL;
const RESEND_TO_EMAIL = process.env.RESEND_TO_EMAIL;

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// Load cookies from file or environment variable
function loadCookies() {
  // Try base64-encoded environment variable first (for cloud deployment)
  if (process.env.COOKIES_JSON_BASE64) {
    try {
      const decoded = Buffer.from(process.env.COOKIES_JSON_BASE64, 'base64').toString('utf-8');
      return JSON.parse(decoded);
    } catch (error) {
      console.error('❌ Error parsing COOKIES_JSON_BASE64 environment variable:', error.message);
      process.exit(1);
    }
  }

  // Try plain JSON environment variable (for Railway deployment)
  if (process.env.COOKIES_JSON) {
    try {
      return JSON.parse(process.env.COOKIES_JSON);
    } catch (error) {
      console.error('❌ Error parsing COOKIES_JSON environment variable:', error.message);
      process.exit(1);
    }
  }

  // Fall back to file (for local development)
  if (!existsSync(COOKIES_PATH)) {
    console.error('❌ cookies.json not found and COOKIES_JSON env var not set! Please run the setup instructions first.');
    process.exit(1);
  }

  try {
    const cookiesJson = readFileSync(COOKIES_PATH, 'utf-8');
    return JSON.parse(cookiesJson);
  } catch (error) {
    console.error('❌ Error reading cookies.json:', error.message);
    process.exit(1);
  }
}

// Load previous ticket state
function loadPreviousState() {
  if (!existsSync(STATE_PATH)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
  } catch (error) {
    console.warn('⚠️  Could not load previous state:', error.message);
    return {};
  }
}

// Save current ticket state
function saveState(state) {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error('❌ Error saving state:', error.message);
  }
}

// Extract ticket information from the page
async function extractTicketInfo(page) {
  return await page.evaluate(() => {
    const tickets = {};

    // Sundance uses react-data-table with rdt_TableRow
    // Each film description is in one cell, action buttons in sibling cells
    const filmDescs = Array.from(document.querySelectorAll('.sd_schedule_film_desc'));

    filmDescs.forEach((filmDesc, index) => {
      // Get film title from h3
      const titleElement = filmDesc.querySelector('h3');
      if (!titleElement) return;

      const title = titleElement.textContent.trim();
      if (!title || title.length < 2) return;

      // Get screening time from date element
      const dateElement = filmDesc.querySelector('.sd_start_end_date');
      const screeningTime = dateElement ? dateElement.textContent.trim().replace(/\s+/g, ' ') : '';

      // Navigate up to the table row container
      const tableRow = filmDesc.closest('.rdt_TableRow, [class*="TableRow"]');

      if (!tableRow) {
        // Fallback if structure changes
        tickets[`${title}_${index}`] = {
          title,
          screeningTime,
          status: 'UNKNOWN',
          buttonText: 'No row container found',
          url: window.location.href
        };
        return;
      }

      // Find all table cells in this row
      const tableCells = Array.from(tableRow.querySelectorAll('.rdt_TableCell, [class*="TableCell"]'));

      // Look for buttons in ALL cells (they're in sibling cells, not the film desc cell)
      let status = 'UNKNOWN';
      let buttonText = '';

      tableCells.forEach(cell => {
        // Skip favorite buttons
        const buttons = Array.from(cell.querySelectorAll('button, a.button, .btn')).filter(
          btn => !btn.className.includes('fav')
        );

        buttons.forEach((button) => {
          const text = button.textContent.trim();
          const upperText = text.toUpperCase();

          // Only process if it looks like an action button
          if (text.length > 0 && !text.match(/^[^a-zA-Z]*$/)) {
            // Has actual text, not just icons
            if (upperText.includes('SOLD OUT')) {
              status = 'SOLD_OUT';
              buttonText = text;
            } else if (upperText.includes('WAITLIST') || upperText.includes('WAIT LIST')) {
              status = 'WAITLIST';
              buttonText = text;
            } else if (
              upperText.includes('ORDER') ||
              upperText.includes('BUY') ||
              upperText.includes('GET') ||
              upperText.includes('TICKETS') ||
              upperText.includes('TICKET') ||
              upperText.includes('PURCHASE') ||
              upperText.includes('AVAILABLE')
            ) {
              status = 'AVAILABLE';
              buttonText = text;
            }
          }
        });
      });

      // Create unique key
      const key = `${title}_${screeningTime || index}`;

      tickets[key] = {
        title,
        screeningTime,
        status,
        buttonText,
        url: window.location.href
      };
    });

    return tickets;
  });
}

// Compare states and detect changes
function detectChanges(previousState, currentState) {
  const changes = [];

  for (const [key, current] of Object.entries(currentState)) {
    const previous = previousState[key];

    // New screening found
    if (!previous) {
      if (current.status === 'AVAILABLE') {
        changes.push({
          type: 'NEW_AVAILABLE',
          ...current
        });
      }
      continue;
    }

    // Status changed from SOLD_OUT to AVAILABLE
    if (previous.status === 'SOLD_OUT' && current.status === 'AVAILABLE') {
      changes.push({
        type: 'NOW_AVAILABLE',
        ...current
      });
    }
  }

  return changes;
}

// Send email notification
async function sendEmailNotification(changes) {
  if (!resend || !RESEND_FROM_EMAIL || !RESEND_TO_EMAIL) {
    return; // Email not configured
  }

  const typeLabels = {
    NOW_AVAILABLE: '🎟️ NOW AVAILABLE (was sold out)',
    NEW_AVAILABLE: '✨ NEW TICKETS FOUND',
    PURCHASE_SUCCESS: '✅ PURCHASE COMPLETED',
    PURCHASE_FAILED: '❌ PURCHASE FAILED',
    PURCHASE_ATTEMPT: '🤖 AUTO-PURCHASE ATTEMPT',
    PURCHASE_READY: '🛒 PURCHASE READY'
  };

  const filmsList = changes.map(c => {
    const type = typeLabels[c.type] || '🎬 UPDATE';
    return `${type}\n📽️  ${c.title}\n⏰ ${c.screeningTime}\n🔗 ${c.url}\n`;
  }).join('\n');

  // Create subject line with film names
  const filmNames = changes.map(c => c.title).join(', ');
  const subject = changes.length === 1
    ? `🎬 Sundance: ${filmNames} - Tickets Available!`
    : `🎬 Sundance: ${changes.length} Films Available (${filmNames})`;

  const html = `
    <h2>🎬 Sundance Ticket Alert!</h2>
    <p><strong>${changes.length} film${changes.length > 1 ? 's have' : ' has'} tickets available:</strong></p>
    ${changes.map(c => {
      const label = typeLabels[c.type] || '🎬 UPDATE';
      return `
      <div style="margin: 20px 0; padding: 15px; border-left: 4px solid #ff6b35; background: #f9f9f9;">
        <div style="font-weight: 600; margin-bottom: 6px;">${label}</div>
        <h3 style="margin: 0 0 10px 0;">${c.title}</h3>
        <p style="margin: 5px 0;"><strong>Time:</strong> ${c.screeningTime}</p>
        <p style="margin: 5px 0;"><strong>Details:</strong> ${c.buttonText}</p>
        <p style="margin: 5px 0;"><a href="${c.url}" style="color: #ff6b35; text-decoration: none;">→ Go to Schedule</a></p>
      </div>
    `;
    }).join('')}
    <p style="margin-top: 20px; color: #666; font-size: 12px;">
      Generated by Sundance Ticket Monitor
    </p>
  `;

  try {
    await resend.emails.send({
      from: RESEND_FROM_EMAIL,
      to: RESEND_TO_EMAIL,
      subject,
      html
    });
    console.log('   ✓ Email notification sent');
  } catch (error) {
    console.error('   ❌ Failed to send email:', error.message);
  }
}

// Display notifications for changes
async function notifyChanges(changes) {
  if (changes.length === 0) return;

  console.log('\n🎬 ═══════════════════════════════════════════════════════');
  console.log('🚨 TICKET AVAILABILITY ALERT! 🚨');
  console.log('═══════════════════════════════════════════════════════\n');

  changes.forEach((change) => {
    if (change.type === 'NOW_AVAILABLE') {
      console.log('🎟️  NOW AVAILABLE (was sold out):');
    } else if (change.type === 'NEW_AVAILABLE') {
      console.log('✨ NEW TICKETS FOUND:');
    }

    console.log(`   📽️  ${change.title}`);
    if (change.screeningTime) {
      console.log(`   ⏰ ${change.screeningTime}`);
    }
    console.log(`   🔘 ${change.buttonText}`);
    console.log(`   🔗 ${change.url}`);
    console.log('');
  });

  console.log('═══════════════════════════════════════════════════════\n');

  // System notification (macOS)
  const titlesList = changes.map(c => c.title).join(', ');
  const message = `${changes.length} ticket(s) available: ${titlesList}`;

  try {
    // Use osascript for macOS notifications (only works on macOS)
    Bun.spawn(['osascript', '-e', `display notification "${message.replace(/"/g, '\\"')}" with title "Sundance Tickets Available!"`]);
  } catch (error) {
    // Silently fail if osascript is not available (e.g., on Linux/Docker)
  }

  // Send email notification
  await sendEmailNotification(changes);
}

// Main monitoring function
async function monitorSchedule() {
  const cookies = loadCookies();
  let previousState = loadPreviousState();

  console.log('🎬 Sundance Ticket Monitor Starting...');
  console.log(`📍 Monitoring: ${SCHEDULE_URL}`);
  console.log(`⏱️  Check interval: ${CHECK_INTERVAL / 1000} seconds\n`);

  const browser = await chromium.launch({
    headless: true
  });

  const context = await browser.newContext();

  // Add cookies to context
  await context.addCookies(cookies);

  const page = await context.newPage();

  // First load: navigate to main page then schedule to establish session
  console.log('🔐 Establishing session...');
  await page.goto('https://festival.sundance.org/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  let checkCount = 0;

  while (true) {
    checkCount++;
    const timestamp = new Date().toLocaleString();

    try {
      console.log(`[${timestamp}] Check #${checkCount} - Loading schedule...`);

      // Navigate to schedule page
      await page.goto(SCHEDULE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

      // Wait for schedule content to load (it's rendered by JavaScript)
      try {
        await page.waitForSelector('.sd_schedule_film_desc', { timeout: 30000 });
      } catch (e) {
        console.log('   ⚠️  Timeout waiting for schedule content');
      }

      // Give dynamic content a bit more time to settle
      await page.waitForTimeout(3000);

      // Extract current ticket information
      const currentState = await extractTicketInfo(page);

      const ticketCount = Object.keys(currentState).length;
      console.log(`   Found ${ticketCount} screening(s) on schedule`);

      // Detect changes
      const changes = detectChanges(previousState, currentState);

      if (changes.length > 0) {
        await notifyChanges(changes);

        // Check for auto-purchase opportunities
        const autoPurchaseConfig = loadAutoPurchaseConfig();
        if (autoPurchaseConfig) {
          for (const change of changes) {
            if ((change.type === 'NOW_AVAILABLE' || change.type === 'NEW_AVAILABLE') &&
                shouldAutoPurchase(change.title, change.screeningTime, autoPurchaseConfig)) {
              console.log(`\n🤖 Auto-purchase triggered for: ${change.title}`);
              if (change.screeningTime) {
                console.log(`   Screening: ${change.screeningTime}`);
              }

              const result = await attemptPurchase(
                page,
                change.title,
                change.screeningTime,
                autoPurchaseConfig,
                sendEmailNotification
              );

              if (result.success) {
                console.log(`   ✓ Auto-purchase ${result.reason}`);
                if (result.url) {
                  console.log(`   🔗 ${result.url}`);
                }
              } else {
                console.log(`   ❌ Auto-purchase failed: ${result.reason}`);
              }

              // Navigate back to schedule for next check
              await page.goto(SCHEDULE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
              await page.waitForTimeout(3000);
            }
          }
        }
      } else {
        console.log('   ✓ No new tickets available\n');
      }

      // Save current state
      saveState(currentState);
      previousState = currentState;

    } catch (error) {
      console.error(`❌ Error during check #${checkCount}:`, error.message);
      console.log('   Retrying on next check...\n');
    }

    // Wait before next check
    await Bun.sleep(CHECK_INTERVAL);
  }

  // Cleanup (won't be reached in normal operation)
  await browser.close();
}

// Run the monitor
monitorSchedule().catch(console.error);
