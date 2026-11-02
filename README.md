# Bidyut Balance

One page to check Bangladesh electricity and water accounts instead of visiting each provider's site.

| Tab | Type | You enter | You get |
| --- | --- | --- | --- |
| DESCO | Prepaid electricity | Account or meter number | Balance, customer details, 6 months of recharges, 12 months of usage |
| NESCO | Prepaid electricity | Customer or meter number | Balance, customer details, recharge history |
| DPDC | Prepaid electricity | 8-digit customer number and a security code from an image | Last recharge and its token, not the balance |
| BPDB | Prepaid electricity | 12-digit meter number | Customer details and recharge tokens from the public token check |
| WZPDCL | Postpaid electricity | Account number | Latest bill: name, meter, tariff, readings, charges and payable amount |
| Dhaka WASA | Postpaid water | Account number and portal password | Customer details, latest bill, bill statement with From/To dates |
| Chattogram WASA | Postpaid water | Account number, optional year and month | Bill with net payable, due date, readings, VAT, surcharges and arrears |

Accounts you check are kept in a Saved meters list in your browser, with a Refresh all button. DPDC and Dhaka WASA accounts are not saved, because they need a security code or password each time.

## Run it

Needs Node.js 18 or newer (tested on 23.11). There is nothing to install.

```bash
node server.js
```

Then open <http://localhost:3002>. To use another port:

```bash
PORT=3005 node server.js
```

The site needs this server. A browser can't call the provider sites directly, so the page has to go through it.

## Demo accounts

Use these numbers to try each tab. They are live records, so results show real, current data.

| Tab             | Number                       |
| --------------- | ---------------------------- |
| DESCO           | `663110113177`               |
| NESCO           | `81900908`                   |
| DPDC            | `21880606`                   |
| BPDB            | `010210936305`               |
| WZPDCL          | `308140914`                  |
| Dhaka WASA      | `0108080691` (Password Same) |
| Chattogram WASA | `121020`                     |

## Project layout

```text
server.js          Server and all provider lookups
public/index.html  The page (HTML, CSS and JavaScript)
certs/             Public intermediate certificates (keep these)
```

## How each provider connects

None of these are public APIs for third parties. The site uses the same pages and endpoints that customers use.

| Provider | Official site | Method |
| --- | --- | --- |
| DESCO | `prepaid.desco.org.bd` | JSON API used by the DESCO site |
| NESCO | `customer.nesco.gov.bd/pre/panel` | Submits the web form and reads the result page |
| DPDC | `dpdc.org.bd/site/service/myPrepaidToken_gov` | Shows DPDC's security code, then submits the person's answer to the page |
| BPDB | `web.bpdbprepaid.gov.bd/bn/token-check` | Calls the page's public lookup the way the site does; the lookup id is read from the page at runtime |
| WZPDCL | `ebill.wzpdcl.gov.bd` | Public Oracle APEX page; the server reproduces its signed submit (session tokens and per-item checksums read from the page) |
| Dhaka WASA | `consumer-portal.dhakawasa.org` | Logs in with the customer's details, submits the date search and reads the statement |
| Chattogram WASA | `ebill.cwasabd.org/ebill` | Fetches the public bill page and reads values by their position on it |

## API

| Method | Path | Input |
| --- | --- | --- |
| GET | `/api/desco` | `no` |
| GET | `/api/desco/recharges` | `account`, `meter` |
| GET | `/api/nesco` | `no` |
| GET | `/api/dpdc/captcha` | None. Returns `captcha` and `image` |
| POST | `/api/dpdc` | JSON: `no`, `code`, `captcha` |
| GET | `/api/bpdb` | `no` (12-digit meter number) |
| GET | `/api/wzpdcl` | `no` (account number) |
| GET | `/api/cwasa` | `no`, optional `month` as `YYYY-MM` |
| POST | `/api/dwasa` | JSON: `no`, `password` |
| POST | `/api/dwasa/statement` | JSON: `session`, `from`, `to` as `YYYY-MM-DD` |

## Good to know

- **Slow answers:** DESCO recharge history can take about a minute, and a Dhaka WASA statement can take several minutes. Both load after the rest of the result. The server waits up to 90 seconds for DESCO and 5 minutes for Dhaka WASA.
- **DESCO rate limit:** DESCO blocks bursts of requests, so the server sends them one at a time and retries.
- **Certificates:** DESCO and Dhaka WASA don't send their full certificate chains, which Node rejects. The server loads every `.pem` file in `certs/` to complete them. Certificate checking stays on. Don't set `rejectUnauthorized: false`.
- **Dhaka WASA amount:** the large amount is the latest bill's total, not the total owed across all bills.
- **Chattogram WASA amount:** arrears are shown separately and are not included in net payable.
- **BPDB:** the lookup is a Next.js server action whose id changes each time BPDB redeploys their site. The server reads the current id from the page at runtime and re-reads it if it goes stale, so it keeps working across their deploys but depends on the page's structure.
- **DPDC:** the public page gives the last recharge only. The balance needs a login on a portal that only supports `http`, so it isn't included. A person must answer the security code for each check, and each code works once.
- **WZPDCL:** served by an Oracle APEX app that signs every submit with per-session checksums. The server reads those from the page for each lookup, so it keeps working, but depends closely on the page's structure and will break if WZPDCL changes their APEX app.
- **Page changes:** NESCO, DPDC, BPDB, WZPDCL, Dhaka WASA and Chattogram WASA are read from web pages, so a change to those pages can break a lookup.

## Security

- **Keep other accounts out of this repository.** A lookup can show a customer's name, address, phone number and recharge tokens. Don't commit passwords, or account numbers beyond the demo accounts above.
- **Dhaka WASA password:** it goes from the page to this server once, is sent to the portal, and is not stored or logged. The server keeps only the portal session in memory for 10 minutes so date searches don't need the password again.
- **Default passwords:** change the Dhaka WASA portal's default password if the portal lets you.
- **Before hosting it publicly:**
  - Serve the site over `https`, because Dhaka WASA passwords pass through it.
  - Tell users their password goes through your server.
  - Add request limits so it doesn't overload the provider sites.
  - Check each provider's terms of use.
- **Chattogram WASA traffic:** that portal only supports `http`, so data between this server and the portal is not encrypted.
