# Sundance Ticket Monitor

Automatically monitors your Sundance Film Festival schedule for ticket availability and alerts you when sold-out tickets become available.

## Features

- **Continuous Monitoring** - Checks your schedule every 60 seconds
- **Smart Detection** - Detects when "Sold out" changes to "Order tickets"
- **Email Notifications** - Get alerts via Resend email service
- **Desktop Notifications** - macOS system alerts (local only)
- **Deployable** - Run on Railway, Fly.io, or any Docker host

## Quick Start

### 1. Install Dependencies

```bash
git clone https://github.com/YOUR_USERNAME/sundance-ticket-monitor.git
cd sundance-ticket-monitor
bun install
bunx playwright install chromium
```

### 2. Export Your Sundance Cookies

1. Log in to [festival.sundance.org](https://festival.sundance.org) in your browser
2. Go to your schedule: https://festival.sundance.org/my-festival/my-schedule
3. Add films to your schedule that you want to monitor
4. Open DevTools (`Cmd+Option+I` on Mac, `F12` on Windows)
5. Go to the **Console** tab and paste:

```javascript
copy(JSON.stringify(
  document.cookie.split('; ').map(c => {
    const [name, value] = c.split('=');
    return {
      name, value,
      domain: '.sundance.org',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'Lax'
    };
  }), null, 2
))
```

6. Create `cookies.json` in the project root and paste the copied content

### 3. Test Your Setup

```bash
bun run test     # Verify cookies work
bun run check    # One-time status check
```

### 4. Start Monitoring

```bash
bun run monitor
```

## Email Notifications (Recommended)

For remote deployment or better notifications, set up email via [Resend](https://resend.com):

1. Create a free account at https://resend.com
2. Get your API key
3. Create `.env` file:

```bash
cp .env.example .env
```

4. Edit `.env`:

```bash
RESEND_API_KEY=re_xxxxx
RESEND_FROM_EMAIL=sundance@yourdomain.com
RESEND_TO_EMAIL=your@email.com
```

## Deployment

### Railway (Recommended)

1. Push to GitHub
2. Go to [railway.app](https://railway.app)
3. Create new project → Deploy from GitHub repo
4. Add environment variables:
   - `RESEND_API_KEY`
   - `RESEND_FROM_EMAIL`
   - `RESEND_TO_EMAIL`
5. Create a volume for `/app/data` (for state persistence)
6. Add your `cookies.json` content as a file or environment variable

### Fly.io

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Login and deploy
fly auth login
fly launch
fly secrets set RESEND_API_KEY=re_xxxxx
fly secrets set RESEND_FROM_EMAIL=sundance@yourdomain.com
fly secrets set RESEND_TO_EMAIL=your@email.com

# Create volume for state
fly volumes create sundance_data --size 1

fly deploy
```

### Docker

```bash
docker build -t sundance-monitor .
docker run -d \
  -e RESEND_API_KEY=re_xxxxx \
  -e RESEND_FROM_EMAIL=sundance@yourdomain.com \
  -e RESEND_TO_EMAIL=your@email.com \
  -v $(pwd)/cookies.json:/app/cookies.json:ro \
  sundance-monitor
```

## Auto-Purchase (Experimental)

Automatically click through checkout when tickets become available:

1. Generate a config from your current schedule (recommended):
```bash
bun run generate:auto-purchase
```
   - This loads your schedule with your cookies and writes `auto-purchase.json` listing each film with `autoPurchase: false` so nothing buys by default.

   **OR** copy the example template:
```bash
cp auto-purchase.json.example auto-purchase.json
```

2. Edit `auto-purchase.json`:
```json
{
  "enabled": true,
  "films": [
    { "title": "The Film You Want", "autoPurchase": true }
  ],
  "settings": {
    "ticketQuantity": 1,
    "notifyOnPurchaseUpdates": true,
    "debugScreenshots": false
  }
}
```

3. When a matching film becomes available, the monitor will:
   - Click "Order tickets"
   - Navigate through checkout
   - Attempt to complete the purchase
   - Send an email update on success/failure (if email is configured)

**Note:** This feature uses best-effort DOM automation. If the checkout flow changes, selectors may need updates. You can enable `debugScreenshots` to capture each step.

### Payment Details

If you already have a saved payment method in your Sundance account, the bot will try to select it automatically.  
If not, you can provide card details via environment variables (recommended) or `auto-purchase.json` settings:

```
SUNDANCE_CARD_NUMBER=4242424242424242
SUNDANCE_CARD_EXP=12/26
SUNDANCE_CARD_CVC=123
SUNDANCE_CARD_NAME=Your Name
SUNDANCE_BILLING_ZIP=12345
```

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `RESEND_API_KEY` | Resend API key for email | (none) |
| `RESEND_FROM_EMAIL` | Email sender address | (none) |
| `RESEND_TO_EMAIL` | Email recipient address | (none) |
| `CHECK_INTERVAL` | Check frequency in ms | 60000 |

## Commands

```bash
bun run monitor      # Start continuous monitoring
bun run check        # One-time status check
bun run test         # Test cookie authentication
bun run test-detect  # Debug page detection
bun run test-checkout "Film Title"  # Run checkout flow in a visible browser
```

## How It Works

1. Loads your Sundance session cookies
2. Navigates to your schedule page
3. Extracts film titles and ticket button states
4. Compares with previous state
5. Sends notifications when "Sold out" → "Order tickets"
6. Repeats every 60 seconds

## Troubleshooting

### "cookies.json not found"
Create the file following the cookie export instructions above.

### "Timeout waiting for schedule content"
The Sundance site is slow. Try again or increase timeouts.

### Cookies expired
Sundance cookies expire after 24-48 hours. Re-export fresh cookies.

### No films detected
Make sure you have films added to your schedule on the Sundance website.

## Cookie Refresh

Cookies expire every 24-48 hours. For long-running deployments:

1. Log in to Sundance on your browser
2. Export fresh cookies
3. Update `cookies.json` on your deployment

## File Structure

```
sundance-ticket-monitor/
├── src/
│   ├── monitor.js        # Main monitoring loop
│   ├── auto-purchase.js  # Auto-purchase logic
│   ├── generate-auto-purchase.js # Builds auto-purchase.json from your schedule
│   ├── check-once.js     # One-time check
│   ├── test-login.js     # Cookie validation
│   └── test-detection.js # Debug tool
├── cookies.json          # Your session cookies (gitignored)
├── auto-purchase.json    # Films to auto-buy (gitignored)
├── .env                  # Environment config (gitignored)
├── Dockerfile            # For deployment
├── railway.json          # Railway config
├── fly.toml              # Fly.io config
└── CLAUDE.md             # AI assistant context
```

## Security Notes

- Never commit `cookies.json` - it contains your session
- Never commit `.env` - it contains API keys
- Both files are in `.gitignore` by default

## License

MIT
