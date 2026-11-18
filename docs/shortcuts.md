# Setup guide (do it all in one go)

Everything below uses the exact English names from the app and from iOS.

## Part 1. App and bot (Mac or iPhone)
1. Open https://budget.in-manager.uz and sign in (login `doniyor`). On iPhone: Safari → Share → **Add to Home Screen**.
2. Bottom tabs: **Home, Transactions, Stats, Accounts, Profile**. Tap **Profile** → **Settings, Telegram**.
3. In the card **Telegram bot** tap **1. Connect webhook** (only once, it should show "Webhook connected: @m0ney_manager_bot"). Then tap **2. Get code**: a 6-digit code appears (valid 10 minutes).
4. In Telegram open @m0ney_manager_bot, send that code. The bot answers "Linked."
5. Tap the card **URL for Shortcuts (SMS and Wallet)** → **Copy**. This is your secret URL, it looks like `https://budget.in-manager.uz/api/in/xxxxxxxx`. Send it to yourself (Notes) to paste into Shortcuts on iPhone.

## Part 2. Opening balances
Tab **Accounts** → tap an account → field **Opening balance** → enter the amount you have today → **Save**. Do it for **Cash**, **UZS card** (also check **Last 4 card digits** = 3153) and **Visa** (amount in dollars). Without this balances count from zero.

## Part 3. iPhone Shortcuts: three automations
Open the **Shortcuts** app → tab **Automation** → **+** (top right) → **New Automation**.

### A. Bank SMS from 5800
1. Choose **Message**.
2. **Sender**: tap **Choose** and pick the contact or number 5800 (type 5800 if it is not in contacts). Leave **Message Contains** empty.
3. Select **Run Immediately**. Turn **Notify When Run** off. Tap **Next**.
4. Tap **New Blank Automation**. Tap **Add Action**, search **Get Contents of URL**, add it.
5. Tap **URL**, paste your secret URL.
6. Tap **Show More** (arrow). **Method**: **POST**. **Request Body**: **JSON**.
7. Tap **Add new field** → **Text**. **Key**: `sms`. **Value**: tap the value, in the variable bar choose **Shortcut Input** (if it asks which part, choose **Content**/**Message**).
8. Tap **Done**.

### B. Wallet: Visa
1. **+** → **Transaction**.
2. **Cards**: tap **Choose** and select only your Visa card. Leave **Merchant** and **Category** as they are.
3. Select **Run Immediately**, turn **Notify When Run** off, tap **Next**.
4. **New Blank Automation** → **Add Action** → **Get Contents of URL**. URL = secret URL. **Show More**: **Method POST**, **Request Body JSON**.
5. Add three fields (type **Text** each):
   - Key `amount`, value: **Shortcut Input** → property **Amount**
   - Key `merchant`, value: **Shortcut Input** → property **Merchant**
   - Key `card`, value: type the plain text `Visa` (do not use a variable)
6. **Done**.

### C. Wallet: UZS card (only if this card is in Apple Wallet)
Same as B, but in step 2 select your UZS card, and for key `card` type the text `UZS card`.

Tip: to pick a property, tap the variable after you insert **Shortcut Input**; a list opens (Amount, Merchant, Card or Pass, Name...).

## How it behaves
- SMS and Wallet for the same payment are merged into one record (same amount within 15 minutes).
- A Visa payment that Wallet reports in sums is converted to dollars at the current rate (the Telegram message shows it).
- **IYB MOBILE EXCHANGE** is recorded as a transfer UZS card → Visa; the dollar part is an estimate at the sell rate, correct it in **Transactions**.
- For a new merchant the bot asks "Which category?" with buttons; next time it remembers.
- If the bank balance in the SMS differs from the app, the bot warns you.

## Quick entry
- Home screen field: `lunch 58000`, `taxi 25k`, `netflix 15$ visa`, `+500000 salary` (plus = income). Without a word: sums go to **Cash**, dollars go to **Visa**. Add `card` for UZS card.
- Same text works in the Telegram bot. Commands: `/balance`, `/budget`, `/help`.
- Payme payment screenshot: send the photo to the bot.

## Check that it works
Make a small Apple Pay payment. Within seconds the bot sends a message "💳 −… · merchant" with category buttons, and the record appears in **Transactions** (source: Wallet). If nothing comes, tell me which automation (A, B, C) and what time, I will check the server log.
