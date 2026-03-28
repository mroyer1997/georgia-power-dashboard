# Georgia Power — Overnight Advantage Dashboard

A local web dashboard that pulls your hourly energy usage from Georgia Power, correctly allocates kWh to rate tiers, and calculates your full estimated daily bill including all riders and fees.

Built for the **Overnight Advantage (TOU-OA-14)** rate plan. Works with any Georgia Power account (Alabama Power and Mississippi Power may also work via the same API).

---

## What It Shows

- Daily kWh split by **Super Off-Peak** (11pm–7am), **Off-Peak**, and **On-Peak** (2–7pm Mon–Fri, June–Sept only)
- Full estimated bill per day including all charges:
  - Base energy (TOU-OA-14)
  - Basic Service Charge ($0.4603/day)
  - Fuel Cost Recovery (TOU-FCR-6)
  - Environmental Compliance Cost Recovery (ECCR-11)
  - Demand Side Management Residential (DSM-R-15)
  - Municipal Franchise Fee (MFF-10)
- 30-day windowed summaries and blended ¢/kWh rate
- Interactive charts and full day-by-day detail table

> **Note:** Sales tax (Georgia state 4% + county) is not included as it varies by location.

---

## Prerequisites

- **macOS** (also works on Windows/Linux with minor path adjustments)
- A **Georgia Power online account** at georgiapower.com
- **Node.js** (version 18 or higher recommended)

---

## Step 1 — Install Node.js

Open Terminal and check if Node is already installed:

```bash
node --version
```

If you see a version number (e.g. `v24.x.x`) skip to Step 2.

If not, install via Homebrew:

```bash
# Install Homebrew if you don't have it
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install Node.js
brew install node
```

On **Apple Silicon Macs (M1/M2/M3/M4)**, if `node` is not found after install:

```bash
echo 'export PATH="/opt/homebrew/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

---

## Step 2 — Download the Files

Create a folder for the project and copy all the `.js` files and `package.json` into it:

```
GPwr/
├── gpower_core.js      ← rate logic, API fetching, disk cache
├── gpower_server.js    ← web dashboard server
├── gpower_cli.js       ← command-line summary (optional)
├── package.json
```

The `gpower_diag*.js` files are diagnostic tools used during development — you don't need them for normal use.

---

## Step 3 — Install Dependencies

In Terminal, navigate to your project folder and install:

```bash
cd ~/Documents/GPwr    # or wherever you put the files
npm install
```

This installs three packages: `express` (web server), `southern-company-api` (Georgia Power authentication), and `dotenv` (loads credentials from `.env`).

---

## Step 4 — Configure

Copy the example environment file and fill in your credentials:

```bash
cp .env.example .env
```

Then open `.env` in any text editor:

```
GP_USERNAME=you@email.com
GP_PASSWORD=yourpassword
CITY_LIMITS=inside
```

**Never commit `.env` to Git** — it's already listed in `.gitignore`.

### All Settings

| Variable | Required | Description |
|---|---|---|
| `GP_USERNAME` | Yes | Your Georgia Power login email |
| `GP_PASSWORD` | Yes | Your Georgia Power password |
| `GP_ACCOUNT` | No | Account number to use (omit to auto-select primary account) |
| `CITY_LIMITS` | No | `inside` or `outside` city limits for franchise fee (default: `inside`) |
| `PORT` | No | Port for the web server (default: `3000`) |

### City Limits Setting

The Municipal Franchise Fee differs based on whether you are inside or outside city limits:

- **Inside city limits:** 3.0701% (use `CITY_LIMITS=inside`)
- **Outside city limits:** 1.1852% (use `CITY_LIMITS=outside`)

If you are unsure, check your Georgia Power bill — the franchise fee line will indicate which rate applies, or call Georgia Power at 1-888-660-5890.

### Start Date

By default the dashboard pulls data starting **February 28, 2026**. To change this, open `gpower_server.js` and edit this line:

```javascript
const START_DATE = new Date(2026, 1, 28);   // month is 0-indexed: 0=Jan, 1=Feb, etc.
```

For example, to start from January 1, 2026:

```javascript
const START_DATE = new Date(2026, 0, 1);
```

> **Note:** Georgia Power's hourly API only retains data for a limited rolling window (approximately 30–60 days). Data older than that will not be available regardless of the start date you set.

---

## Step 5 — Run the Dashboard

```bash
npm start
```

> **Important:** Always use `npm start` rather than `node gpower_server.js` directly. The npm script includes a flag that ensures your `.env` credentials are loaded before anything else runs. Running Node directly bypasses this and will cause a login failure even if your `.env` file is correct.

Then open your browser to **http://localhost:3000**

You should see output like:

```
🔌 Georgia Power Dashboard running at http://localhost:3000
   City limits : inside
   Data period : Sat Feb 28 2026 → today
   Cache TTL   : 30 min

[cache miss] Fetching from Georgia Power…
  Accounts to fetch: Sandtrap
  Sandtrap: 0 days cached, fetching 27 new/recent days…
  → 27 days total in results
[cache] Data refreshed.
```

**The first run takes 20–40 seconds** as it fetches each day individually (this is required by Georgia Power's API). After that, a `gpower_cache.json` file is created in your project folder. On subsequent startups, only new days and the last 2 days are re-fetched, so startup takes just a few seconds.

---

## Daily Use

Once set up, your typical workflow is:

```bash
cd ~/Documents/GPwr
npm start
```

Then open http://localhost:3000. The dashboard loads quickly from the local cache and only fetches new days from Georgia Power.

To stop the server press `Ctrl+C` in Terminal.

---

## Updating Rate Tariffs

Georgia Power files rate changes with the Georgia Public Service Commission (PSC). When rates change, update the values in `gpower_core.js`:

### Base Rates (TOU-OA-14)

```javascript
export const BASE_RATES = {
  SUPER_OFF_PEAK : 0.021859,   // $/kWh — 11pm–7am, every day, all months
  OFF_PEAK       : 0.101676,   // $/kWh — all other non-peak hours
  ON_PEAK        : 0.297868,   // $/kWh — 2pm–7pm Mon–Fri, June–Sept
  BASIC_SERVICE  : 0.4603,     // $/day — fixed daily charge
};
```

Source: [TOU-OA-14 Tariff PDF](https://www.georgiapower.com/content/dam/georgia-power/pdfs/residential-pdfs/tariffs/2025/tou-oa-14.pdf)

### Rider Rates

```javascript
export const RIDERS = {
  FCR: {
    ON_PEAK  : 0.066871,   // Fuel Cost Recovery — On-Peak $/kWh
    OFF_PEAK : 0.042398,   // Fuel Cost Recovery — Off-Peak $/kWh (also Super Off-Peak)
  },
  ECCR: { RATE: 0.162813 },   // Environmental Compliance — % of (base + FCR)
  DSM_R: { RATE: 0.012165 },  // Demand Side Management — % of (base + FCR)
  MFF: {
    INSIDE_CITY  : 0.030701,  // Municipal Franchise Fee — inside city limits
    OUTSIDE_CITY : 0.011852,  // Municipal Franchise Fee — outside city limits
  },
};
```

### When to Check for Updates

| Rider | Schedule | Tariff |
|---|---|---|
| Fuel Cost Recovery (FCR) | As filed — check after major fuel cost filings | TOU-FCR-* |
| ECCR | Infrequent | ECCR-* |
| DSM-R | Every January | DSM-R-* |
| MFF | Every November (effective January) | MFF-* |

The current tariff PDFs are at:
`https://www.georgiapower.com/residential/rate-plans/overnight-advantage.html`

> **Pending change:** Georgia Power filed in February 2026 (Docket 56765) to lower Fuel Cost Recovery rates starting summer 2026. Update `RIDERS.FCR` when the PSC approves and the new TOU-FCR tariff is published.

---

## How the Bill Is Calculated

The dashboard calculates costs by cascading charges in the correct order:

```
1. Base Energy Charge
     Super Off-Peak kWh  × $0.021859
     Off-Peak kWh        × $0.101676
     On-Peak kWh         × $0.297868
   + Basic Service Charge  $0.4603/day
   = BASE BILL

2. Fuel Cost Recovery (flat $/kWh adder)
     On-Peak kWh         × $0.066871
     Off-Peak + Super     × $0.042398
   = FCR CHARGE

3. ECCR   =  16.2813%  ×  (BASE BILL + FCR)
4. DSM-R  =   1.2165%  ×  (BASE BILL + FCR)

5. Municipal Franchise Fee
     Inside city:   3.0701%  ×  (BASE BILL + FCR + ECCR + DSM-R)
     Outside city:  1.1852%  ×  same

TOTAL ESTIMATED = BASE BILL + FCR + ECCR + DSM-R + MFF
```

---

## Rate Tier Schedule

| Tier | Hours | Months | Days |
|---|---|---|---|
| **Super Off-Peak** | 11:00 PM – 7:00 AM | All year | Every day |
| **On-Peak** | 2:00 PM – 7:00 PM | June – September | Mon–Fri only (excl. Independence Day & Labor Day) |
| **Off-Peak** | All other hours | — | — |

---

## CLI Mode (Optional)

If you prefer a command-line summary instead of the web dashboard:

```bash
npm run cli
```

This outputs 30-day windowed summaries and a last-14-days detail table to the terminal, and saves a `gpower_hourly_costs.csv` file you can open in Excel.

---

## Files Reference

| File | Purpose |
|---|---|
| `gpower_core.js` | Rate constants, tier logic, API fetching, disk cache. **Edit this to update rates.** |
| `gpower_server.js` | Express web server and dashboard UI |
| `gpower_cli.js` | Command-line runner, outputs CSV |
| `package.json` | Node.js project config, dependencies, and npm scripts. The `start`, `server`, and `cli` scripts include the flags needed to load `.env` correctly — always use `npm start` / `npm run cli` rather than running Node directly. |
| `gpower_cache.json` | Auto-created on first run. Stores processed daily data to avoid re-fetching. Safe to delete to force a full re-fetch. |
| `.env` | You create this (copy from `.env.example`). Contains your credentials. Never committed to Git. |
| `.env.example` | Template showing all available settings. |
| `.gitignore` | Ensures `.env`, `gpower_cache.json`, and `node_modules` are never committed. |
| `LICENSE` | MIT License. |

---

## Troubleshooting

**Dashboard shows all zeros / no data**
- Hard-refresh the browser (`Cmd+Shift+R`)
- Check the Terminal output for error messages
- Delete `gpower_cache.json` and restart to force a full re-fetch

**"Cannot find module" error on startup**
- Run `npm install` in the project folder first

**Login fails**
- Verify your credentials work at georgiapower.com
- Make sure you are running `npm start` and not `node gpower_server.js` directly — the latter bypasses dotenv loading and will always fail
- If your password contains special characters, wrap the value in double quotes in `.env`: `GP_PASSWORD="your$p@ss"`

**Data stops a few days ago**
- Normal — Georgia Power's hourly data is typically available within 24–48 hours of real-time. Very recent days may show no data until GP processes them.

**Wrong account showing**
- The dashboard automatically selects your primary account. If you have multiple accounts and want a specific one, set `GP_ACCOUNT=<account number>`.

**npm not found**
- Node.js is not installed. Follow Step 1 above.

---

## Disclaimer

This project is an independent, unofficial tool and is **not affiliated with, endorsed by, or connected to Georgia Power or Southern Company** in any way.

It works by reverse-engineering Georgia Power's internal web portal API — the same API your browser uses when you log in to georgiapower.com. This API is undocumented and unsupported. Georgia Power may change it at any time, which could break this tool without warning.

Use at your own risk. Always verify important figures against your official Georgia Power bill.

---

## Limitations


- This uses Georgia Power's internal web portal API, which is **not officially documented or supported**. Georgia Power could change their API at any time and break this tool.
- Data availability window is approximately 30–60 days of hourly history. Older data is not accessible via the API (but can be downloaded manually as CSV from the portal).
- This is for the **Overnight Advantage** rate plan only. Other rate plans use different tier structures.
- Estimates will differ slightly from your actual bill due to rounding, billing period boundaries, and any applicable credits or special programs on your account.
