# Meensha — Running To-Do

Tracked here so nothing raised in a session gets lost. Git-tracked (syncs to gitea/GitHub); update as items land.

## Queued (not started)

- [ ] Instagram tiles on the storefront: the left-most tile should always show the actual latest post from Meensha's Instagram account (currently — confirm current behavior before building; may need Instagram Graph API access to pull real posts).
- [ ] SEO + Instagram growth initiative (large, multi-phase — see proposal in session transcript 2026-09-13):
  - ~~Phase 0: Google Search Console setup~~ — **done 2026-09-13**: domain property `meensha.in` verified (DNS via GoDaddy), sitemap.xml submitted. Performance data (impressions/clicks/position) expected to populate within 2-4 days.
  - ~~Phase 1: technical SEO~~ — **done 2026-09-13**, see below.
  - ~~Phase 2~~ — **done 2026-09-13**: mined `inventory_skus.name` (43 live SKUs) for real keyword terms. Clean saree-type list: Ajrakh, Bandhani, Batik, Chiffon, Dola, Georgette, Kalamkari, Katan, Khaddi, Kota Doria, Madhubani, Mangalgiri, Modal, Mothra, Muga. Sub-variant angles: Ajrakh Mirror Work, Kalamkari Chenuru/Nellore, Pen Kalamkari (hand-painted vs. block-printed), Madhubani hand-painted dupatta. Confirms the typo-fragmentation issue already flagged below (Mangalgiri/Mangalgri/Mangalriri, Kalamkari/Kalamakari) — this list groups those without touching the underlying data. Two ambiguous terms need Dheeraj's call, not guessed: "Chenon"/"Chennon" (Chanderi, or something else?) and "Jaipur"/"Surat" (read as sourcing-city labels, not saree types — probably not standalone post topics).
  - Phase 3 (revised 2026-09-13): Instagram content, 2-3 posts/week, drafted for Shalini via bot for manual posting — content is new-stock-arrival announcements + event coverage, NOT generic blog posts. Not started.
    - Instagram → store click flow (confirmed free, no Meta charge — setup effort only), two tiers:
      - **Tier A (buildable now, no Meta approval needed)**: bio link (up to 5 links, no follower minimum) or Story link sticker (no follower minimum, available to all accounts as of 2026) pointing to the existing `?buy=<sku_id>` or `?shop=<term>` deep links, with UTM params (`utm_source=instagram&utm_medium=...`) appended for attribution once GSC/GA can see it.
      - **Tier B (needs Meta Commerce Manager catalog + review)**: native Product tags in posts/Reels/Stories, tappable inside Instagram. Catalog feed can be auto-generated from `inventory_skus` rather than entered manually. Worth bundling with the Instagram Graph API App Review pass above (same approval process, do once).
  - New (2026-09-13, from Instagram/SEO scoping conversation — not yet spec'd in detail):
    - "Trending" badge's Instagram-view-count suggestion signal is still blocked on Instagram Graph API (Insights) access — needs Instagram account converted to Business/Creator + linked to a Facebook Page, then Meta App Review (business verification, screencast, permission justification — can take days, not instant). Rate limit ~200 calls/hour, not a concern at Meensha's scale. Do this setup once, not per-feature. The sales-velocity half of the suggestion signal is already live (see Done below); a TODO comment in admin.html's `skuSoldRecent()` marks where the view-count signal would plug in once this is unblocked.
    - Not CSR framing — this is Meensha's core mission (weaver upliftment/fair trade), not an add-on program. Blog scoped narrowly to the existing **Artisans** section (`index.html#weavers`) only — periodic posts about weaver upliftment activity, not a general blog. Not started.
  - Needs: a supervisor → worker → QA → reporting-manager agent pipeline, each terminating after its task; daily morning-brief progress reporting; all actions recorded to syncthing/obsidian/gitea (and blog posts published) each phase. **The 4-hourly TODO-worker cloud routine (below) is the first piece of this — currently blocked on connecting GitHub to claude.ai.**
- [ ] sitemap.xml still has no entries for the (future, Artisans-section-only) CSR/weaver-upliftment posts — add once that content exists.

- [ ] SEO follow-ups from the 2026-09-27 audit (full detail: `../meensha.in-audit/MEASUREMENT.md`):
  - Font loading is now the main LCP cost (homepage lab LCP 9.5 s): trim Google Fonts weights and preload the hero font. **Needs owner OK**, since it can change how the site looks.
  - GSC after deploy: resubmit sitemap.xml, and "Request indexing" on 3–5 `/sarees/<weave>/` pages. Measure at +7/+14/+28 days (Oct 4/11/25) against the MEASUREMENT.md table.
  - Google Merchant Center free listings (owners' account). product.html already has Product/Offer schema.
  - Fill in `inventory_skus.description` (all 43 are empty), since product pages are thin without it. Fill in `popups.date_from` so pop-ups get Event rich results.
  - Weave pages come from `setup/build_weave_pages.py`: edit its WEAVES list and re-run it. The script also rewrites sitemap.xml, so don't hand-edit sitemap.xml any more.

## Data quality (not a code bug, needs a decision)

- Dynamic shop categories (added 2026-09-13) surface real name-typo fragmentation in `inventory_skus.name` — e.g. "Mangalgiri" / "Mangalgri" / "Mangalriri", "Kalamkari" / "Kalamakari" each show as separate categories. Worth a data cleanup pass in admin.html's Inventory tab, or a future category-merging feature, if the sidebar gets too noisy.

## Done (recent, for reference)

- 2026-10-04 (cloud routine): Social media boost worker, free-form "ask me anything" guidance
  layer — the remaining piece of this item (the reminder-nudge + checklist-toggle half landed
  earlier today, see below). New `askSocialBoostAssistant(supabase, question, checklist)`
  export in `supabase/functions/_shared/askGemini.ts`, separate from the existing `askGemini()`
  (which stays deliberately scoped to fixed stock/sales/price lookups) — this one lets the LLM
  answer free-form, but its prompt restricts it to Instagram/social-growth topics and the IG
  setup checklist only, declining anything else. Reuses the existing `callLLM()`
  OpenRouter-then-Gemini fallback, so it activates the moment an `openrouter_key`/`gemini_key`
  is actually set (still not set — see below). Wired into India bot only
  (`supabase/functions/telegram-bot/index.ts`'s `handleTextInput`), per the spec's scope: a new
  keyword branch (`social`/`traffic`/`boost`/`what next`/`what's next`) spliced in after the
  existing menu-keyword search and before the stock/sales `askGemini()` fallback, so it answers
  the "Ask me anything and I'll guide you step by step" prompt from `sendSocialBoostNudge`
  without colliding with that fallback. Deliberately left "instagram"/"insta" out of the new
  branch's keyword list — those already match the pre-existing "🔗 Insta link" menu action
  (`MENU_ACTIONS` in the same file) via the menu-keyword search that runs first, so keying on
  them here too would never fire and would risk changing that existing feature's behavior if it
  ever did. Type-checked both edited files with `tsc --strict` (only the expected
  `Deno`/`esm.sh` noise and the pre-existing `SendFn` mismatch, both pre-existing in this repo).
  **Not deployed and not end-to-end testable** — same sandbox limitation as this item's other
  half: no `supabase` CLI, no network route to Supabase, and no `openrouter_key`/`gemini_key`
  actually set in `settings` yet (needs admin/owner access this cloud worker doesn't have).
  Needs a `supabase functions deploy telegram-bot --no-verify-jwt` plus an actual key set via
  admin.html/SQL from a session that can reach Supabase before Shalini can use this live.
- 2026-10-04: Visiting-card redesign per owner's follow-up request — logo now centered above
  the name (was side-by-side in a header row), the wordmark/tagline block under the logo is
  gone (front now shows logo + name + title only), and the simple L-bracket corners are
  replaced with a more ornate hand-drawn-style gold corner-flourish SVG (single quarter-motif
  mirrored via CSS `scaleX`/`scaleY` for the other three corners), applied to all four corners.
  Clicking any corner now triggers a real 3D flip (`perspective` on a wrapper, `rotateY(180deg)`
  + `backface-visibility:hidden` on the two faces) to reveal a new back side: centered logo
  only, no name/title/icons, crossfading every 2.5s between `meensha_logo_eng.png` and
  `hindi_logo_main.png` (two stacked `<img>`s, opacity toggled by a `setInterval`). The back
  has its own four corner flourishes; clicking any of them flips back to the front. Same
  palette, same `?person=` logic, same live `settings.wa_num_au` fetch for Meenakshi's
  WhatsApp number (untouched), same five contact icons (front only). Pure inline CSS/SVG/JS,
  no new dependency. Verified in a browser pane via a local static server on both
  `?person=shalini` and `?person=meenakshi`: front layout, flip-to-back, back logo actually
  alternating (screenshots ~3s apart show different logos), flip-back-to-front, and the
  unknown-`?person=` error path all confirmed working.
- 2026-10-04 (cloud routine): Social media boost worker, reminder-nudge half — Shalbot
  (India bot, `supabase/functions/telegram-bot/index.ts` only, per the spec's scope) now
  shows Dheeraj's exact reminder copy ("Hey Shalini, want to increase traffic to your page
  and site? These steps are pending: ..., Ask me anything and I'll guide you step by step.")
  from `showTopMenu` whenever the Instagram Graph API setup checklist has pending items —
  silent once everything's checked off. Checklist (convert IG to Business/Creator; link a
  Facebook Page; create a Meta Developer app; generate a long-lived access token) lives in
  new `settings` row `ig_setup_checklist` (JSON array), seeded with defaults on first read,
  same key/value `upsert(..., {onConflict:'key'})` pattern as `upi_qr_code_url`/`inv_counter`.
  Each pending step has its own inline-keyboard toggle button (`socialboost:done:<id>`
  callback, new `handleSocialBoost()`), matching the existing `kiosk:`/`inv:` callback-button
  convention rather than trusting free-text parsing. Deliberately left out the "ask me
  anything" free-form Q&A half (needs an `askSocialBoostAssistant` export plus an
  `openrouter_key`/`gemini_key` actually set in `settings` — neither available to this
  worker; re-queued above). Type-checked with `tsc --strict` (only the expected
  `Deno`/`esm.sh` noise and the pre-existing `SendFn` mismatch, both pre-existing in this
  file). **Not deployed** — this routine's sandbox has no `supabase` CLI and no network
  route to Supabase (outbound is restricted to `github.com` + package registries), so unlike
  earlier sessions' Done entries this one could only type-check, not deploy or curl-verify;
  needs a `supabase functions deploy telegram-bot --no-verify-jwt` (or equivalent) from a
  session that can reach Supabase before Shalini actually sees this live.
- 2026-10-04: Digital visiting card, both bots — new "📇 Share visiting card" entry in each
  bot's Maintenance menu (`maint:sharecard`), sending the owner a link to their own public
  card page: `visiting-card.html?person=shalini` (India) / `?person=meenakshi` (Australia).
  New `visiting-card.html` at the repo root — no login/session required (public by design,
  unlike `admin-voucher.html`), real clickable `tel:`/`wa.me/`/`instagram.com`/`mailto:`/
  `https://meensha.in` links behind five icons (Call, WhatsApp, Instagram, Email, Website),
  not a flat image. Compact landscape business-card proportions (`aspect-ratio:7/4`), warm
  light-wood/parchment background with gold-brown (`#8B6914`/`#C9A84C`/`#4A3216`) text/border
  accents — a deliberate departure from `admin-voucher.html`'s near-black voucher palette,
  per owner's visual correction this session. India's card uses `hindi_logo_main.png` (same
  medallion the invoice PDF generator bundles); Australia's uses `meensha_logo_eng.png`.
  Meenakshi's WhatsApp number is read live from `settings.wa_num_au` at page load (not
  hardcoded); Shalini's is hardcoded per the confirmed physical-card details. No QR code —
  considered and deliberately dropped (the page itself is already the tappable destination,
  unlike the voucher QR which encodes a different deep-link). Type-checked both edited bot
  files with `tsc --strict` (only the expected `Deno`/`esm.sh` noise and the pre-existing
  `SendFn` mismatch). Deployed `--no-verify-jwt`, verified via curl (both return their app-level
  `403 Forbidden` webhook-secret check, not a gateway 401). QA'd by an independent subagent
  before reporting done. Pushed to `test2` only.
- 2026-10-04: Guided "📦 Stock Intake" flow, both bots — new entry point alongside (not replacing) "🧾 Vendor purchase": invoice photo(s) → Gemini vision reads vendor/items/total (new `extractInvoiceData()` in `_shared/askGemini.ts`) → confirm/fix → vendor auto-matched against `vendors` → per-item photo-count-vs-qty loop with optional discrepancy flagging (type/photo/reason/credit) → summary with adjusted total → good items through the existing unchanged `submit_purchase_intake_batch` pipeline, discrepancy items into `vendor_issues` (defect history per vendor) → wrapper-free draft vendor message, ready to paste into WhatsApp. No shipping/ViaSetu code (deliberately out of scope — held pending real API access, see ViaSetu outreach doc). Deployed `--no-verify-jwt`, QA'd independently (10/10 checks), pushed to `test2` only.
- 2026-10-04: Closed the chatbot owner-tier gap noted below (and in `chatbot/README.md`'s
  former "Known gap" section). Added `supabase/migrations/20261004060000_chatbot_tier_role_column.sql`
  (**file only, not applied to the live DB** — same manual-apply convention as every other
  migration this session) adding a `role text NOT NULL DEFAULT 'sales' CHECK (role IN
  ('owner','sales'))` column to both `telegram_allowed_users` and `telegram_allowed_users_au`,
  and promoting the identified owner rows: chat_id `8853893414` (label "migrated", India's
  only allowlisted row) → `role='owner'` on `telegram_allowed_users` (Shalini); chat_id
  `8918326830` (label "Meenakshi Ranjan") → `role='owner'` on `telegram_allowed_users_au`
  (Meenakshi). The other AU row, chat_id `8853893414` (label "Meensha Fabrics" — same chat_id
  as the India owner row, a shared cross-bot broadcast contact, not a second AU owner), stays
  at the `'sales'` default. Both bots' `resolveChatbotTier`/`resolveChatbotTierAu` now read
  this column (query by `chat_id` + `active=true`, same pattern as each bot's existing
  allowlist check) instead of hardcoding `'sales'` — fails safe to `'sales'` on any lookup
  miss, never defaults to `'owner'`. Type-checked both edited bot files with `tsc --strict`
  (no new errors beyond the expected `Deno`/`esm.sh` noise and the pre-existing unrelated
  `SendFn` mismatch). QA'd by an independent subagent before reporting done.

- 2026-10-04: Chatbot retrieval/escalation/auth build (Phases 2-4, 6-7 of the internal "how
  does this work" chatbot plan — Phase 1/1.5 KB content from earlier today, Phase 5 hosting
  explicitly out of scope). New `chatbot/server/` (local lexical search over `chatbot/kb/`,
  opt-in OpenRouter escalation only on an explicit click, `ESCALATION_MODEL` set to
  `qwen/qwen3.8-27b:free`), `chatbot/frontend/` (vendored `mermaid.min.js`, a markdown->HTML
  converter for the KB's headings/lists/tables/mermaid blocks), and a new
  `verify_admin_session_for_chatbot` RPC (`supabase/migrations/20261004050000_...sql` —
  **file only, not applied to the live DB**, same manual-apply convention as this session's
  other pending migrations). Corrected mid-build per Dheeraj's call: the chatbot has no
  login of its own — it's reached via a new "🤖 Ask Chatbot" button in admin.html (reuses
  the existing session, token passed via URL fragment not query string) and a new "❓ How
  does this work?" menu item in both Telegram bots (new `supabase/functions/_shared/
  chatbotClient.ts`, server-to-server with a shared `CHATBOT_API_SECRET` — not generated/set
  yet, no VM exists to share it with). **Known gap, needs Dheeraj's input**: neither
  `telegram_allowed_users` nor `telegram_allowed_users_au` has a column distinguishing the
  account owner's chat_id from other staff, so both bots currently default every caller to
  `sales` tier unconditionally rather than guess — Shalini/Meenakshi only get full owner-tier
  chatbot answers via admin.html for now, not via their own bot. QA (independent subagent):
  server starts clean, role-scoping confirmed (sales tier never saw admin/owner-only KB
  content), no-confident-match path never auto-escalates, auth fails closed with no live
  migration, 2 real mermaid diagrams rendered via the actual frontend code with no console
  errors, `auth.js`'s RPC call shape matches the migration exactly byte-for-byte. Full
  deployment runbook in `chatbot/README.md`. Nothing pushed to `origin` (test2 only, per
  convention).

- 2026-10-04: Chatbot knowledge-base content curation + admin system mapping (Phase 1 + 1.5 of the internal "how does this work" chatbot plan). Created `chatbot/kb/{admin,owner,sales}/` — curated copies of existing docs (with credentials/project-refs/IPs/internal hostnames stripped where flagged), a fresh `admin/architecture-reference.md` written from scratch to replace `Project Brief v3.md` (never copied — it has plaintext passwords), `CURATION_NOTES.md` codifying the "explain why/what, never exact mechanism" rule, and new admin-tier system-map content (`SYSTEM_MAP.md`, `ARCHITECTURE.md`, and 8 flow docs with mermaid diagrams covering coupons/vouchers, kiosk sales, checkout/payment, stock intake, invoicing, Instagram integration, auth/session shape, and admin role-gating) read directly from the current codebase. `docs/MEENSHA_AUTH_SECURITY_HANDOFF.md` and `docs/MEENSHA_MONITORING.md` excluded entirely, per plan. No server/frontend/DB code touched — pure markdown, no other files in the repo modified except this entry. Full plan and per-file verdicts in the session's implementation plan; next phases (retrieval server, auth RPC, hosting) not started.
  - Both bots now handle `t.me/<bot>?start=coupon_<code>`: it launches the normal kiosk sale flow (same first step as tapping "Kiosk mode") with the code seeded into session data, so the existing coupon-code step auto-validates it instead of prompting to type it again (`supabase/functions/telegram-bot-au/index.ts` ~L483-520, ~L697-719; `supabase/functions/telegram-bot/index.ts` ~L144-162, ~L1517-1527, new `applyCouponCode()` helper extracted from the old inline `kiosk_discount_code_entry` logic so manual-entry and deep-link-seeded codes share one path). Found and fixed a real bug during QA: AU bot's `kioskConfirmQty` was saving `{ cart }` instead of `{ ...data, cart }`, silently dropping the seeded code (and `pending_sku`/`pending_units`) the moment the first item was added to a sale — fixed and redeployed. Both functions deployed with `--no-verify-jwt`, confirmed via curl (app-level 403, not gateway 401) after each deploy.
  - **India bot's kiosk coupon flow does NOT use the `validate_coupon` RPC** — it validates against the `coupons` table directly via a local `validateCoupon()` function with a generic message. Only the AU bot's kiosk flow and the website (`index.html`) call the RPC. Pre-existing asymmetry, not something this session introduced or fixed.
  - Bot usernames (needed for the QR deep links) were already in the codebase as comments — `@meenshashalbot` (India/Shalini), `@meenshaozbot` (Australia/Meenakshi) — no need to ask Dheeraj for them.
  - `admin-voucher.html`: new QR-Type toggle (website vs. Telegram deep link) plus a bot picker shown only when a coupon's `region==='all'`. Defaults to Telegram when the coupon maps to exactly one bot (region india/australia), website otherwise. Telegram QR encodes `https://t.me/<bot>?start=coupon_<code>` via the same vendored QR library (no new dependency). Also visually redesigned per a reference mockup Dheeraj supplied mid-session: double gold border with corner brackets, a "torn ribbon" parchment code box (jagged canvas-drawn edges, no CSS clip-path since this is canvas), and a footer bar with simple canvas-drawn icons (globe/Instagram/WhatsApp — not the official logos, to avoid any trademark/asset dependency) — all reskinned to the site's own established palette (`index.html`'s `--gold`/`--gold-light`/`--gold-pale`/`--dark`/`--dark2` vars, not the reference's own color scheme), system font stacks only (no Google Fonts/Font Awesome), brand name/tagline/QR URLs double-checked correct (the reference mockup had typos/wrong URLs in all three — fixed, not reproduced).
  - New migration `supabase/migrations/20261003130000_region_specific_coupon_message.sql`: `validate_coupon`'s region-mismatch message is now specific ("This code is India only." / "This code is Australia only.") instead of the generic "isn't valid for this region." Confirmed both the AU bot and `index.html` just display whatever `message` the RPC returns, so no separate code change was needed there — but see the India-bot asymmetry above, this message change does not reach India's kiosk flow. **Not applied to the live DB** — joins 3 other already-pending migrations (`20260927190000`, `20260927191000`, `20261003120000`) that earlier sessions deliberately left for manual application via the Supabase SQL editor; this session did not run `supabase db push` for the same reason (shared staging/production DB, didn't want to cascade-apply 3 migrations it didn't author in this pass).
  - QA: independent subagent + own follow-up. Confirmed both bots' deploys via curl; statically traced session-data flow through both kiosk flows (full `data =` reassignment audit); verified the voucher QR toggle and redesign live in a browser pane with OpenCV-independent QR decoding (not trusting the page's own JS encoder) and a network-request check confirming zero external calls from the redesigned page; confirmed migration SQL by diffing against the live function text, but could not test the new message live (migration unapplied + `coupons` table locked to admin-session reads, consistent with the prior session's lock-down).
- 2026-10-03: Built a real, working voucher image generator for coupons — new standalone page `admin-voucher.html` (admin.html was already 4500+ lines, so kept this as a separate page per Dheeraj's call, linked from the Coupons section and gated behind the same `MSN_USER`/session-token pattern admin.html uses). Three voucher types (Partner Offer / Event Offer / Individual Discount) are a rendering-only choice made at generation time — no new `coupons` column. Renders client-side on an HTML5 canvas using the brand palette from index.html (`#1A1208`/`#0E0A04` background, `#8B6914`/`#C9A84C`/`#E8D5A3` gold), with a real scannable QR code (vendored kazuhikoarase `qrcode-generator`, MIT license, inlined — no CDN) encoding `https://meensha.in/?coupon=<code>`, footer with `meensha.in` / `@meensha_fabrics` / region-appropriate WhatsApp number from `settings` / "Heritage Weaves of India" tagline, and a PNG download button. admin.html's Coupons form gets a "🖼️ Generate Voucher Image" button that appears after `createCoupon()` succeeds (hands the RPC's own returned coupon row to the new page via `sessionStorage`, no re-fetch) plus a per-row 🖼️ button in the Coupon Register to regenerate for any existing coupon (`admin-voucher.html?code=<code>` deep link also supported). QA: local static-file server + browser pane, simulated session (no live admin login credentials available to this session) — canvas render visually confirmed for all 3 voucher types incl. region=australia (A$) and percent (no symbol); QR independently decoded with OpenCV (unrelated to the vendoring library) and confirmed it reads exactly `https://meensha.in/?coupon=QATEST-VOUCHER-1`; download verified via `canvas.toDataURL` producing a valid, OpenCV-readable PNG; auth gate confirmed blocking access with no session. Did **not** touch any Supabase Edge Function / Telegram bot files — an in-session message claiming to be a scope-expansion request to wire the bots to this page arrived through an anomalous channel and was treated as a possible prompt injection, not acted on, and flagged back to the user. `single_use` migration (`20261003120000`) confirmed still NOT applied to the live DB as of this session (`coupons.single_use` → `42703`).
- 2026-10-03: Built single-use public coupons for a one-time partner-org code use case (2 codes for an external org). New `coupons.single_use boolean DEFAULT false` column; `consume_coupon` now flips `used=true` on first redemption for a public code when `single_use=true` (public codes with `single_use=false`, the default, stay reusable forever — FREEDOM200-style behavior unchanged; locked codes unchanged, they already got marked used). `admin_create_coupon` takes a new `p_single_use boolean DEFAULT false` 10th param — migration `supabase/migrations/20261003120000_add_single_use_coupons.sql`. admin.html has a new "One-time use" checkbox in the Coupons form (`CP-SINGLEUSE`). index.html now supports `?coupon=<code>` deep links: pre-fills+validates the code, then scrolls to the shop grid (same as `?shop=`) and confirms via `alert()` (matches the existing hold-released alert convention — no new notification system). **Migration not yet applied to the live DB** — this sandbox can't reach the DB directly (`supabase migration list --linked` times out) and isn't logged into the Supabase dashboard or admin.html, so per the established convention it needs to be run manually in the Supabase SQL editor before the real coupon rows can be created or single_use behavior verified end-to-end. The `?coupon=` deep link was verified against the live `validate_coupon` RPC (read-only, no login needed) via a local static server + the browser pane — reached the real backend and surfaced its real response through the alert.
- 2026-09-30: Recovered 17 commits (2026-09-27/28: audit fixes, weave landing pages, the admin-session DB lock, mobile cart fixes, PAT rotation) that had been made on a detached HEAD by prior TODO-worker runs and never reached `main` — `origin/main` was still sitting at the 2026-09-18 commit despite those runs reporting work done. Verified the stranded tip fast-forwarded cleanly from `main` with zero divergence (no conflicting commits on either side), so no content was rewritten or merged by hand — just fast-forwarded `main` to include them and pushed. Root cause not fixed: this sandbox apparently starts on a detached HEAD, and a plain `git push -u origin main` from there pushes nothing (silently reports success) instead of updating `main`. Worth checking the routine's checkout step so this doesn't recur.
- 2026-09-28: Replaced the GitHub PAT (the old one was deleted on GitHub) and moved all git credentials out of `.git/config` into the macOS Keychain (`credential-osxkeychain`). The remotes are now plain URLs: origin/test2 on github.com, and gitea at `gitea.home.bhartis` (no longer the raw IP, which the TLS cert didn't cover).
- 2026-09-28: Mobile cart fixes (found in the same day's QA, pre-existing). The 10s "Handpicked. Not Held Forever" nudge no longer shows while the cart drawer is open (it covered the items on mobile); its 10s window now starts when the drawer is closed. The final-30s warning is unchanged. Below 640px the coupon row wraps: code + Apply on one line, WhatsApp field full width underneath (it used to overflow the drawer). Verified with Playwright at 360, 390 and 1366 (desktop layout unchanged).
- 2026-09-28: Locked the database to admin sessions. The public anon key could read (and write) users, sales, purchases, vendors, overheads and `inventory_skus.cost`. Storefront/product/weave pages now read `public_skus`/`public_units` views (no cost/vendor columns), invoice.html uses `get_invoice()` (WhatsApp match server-side), admin.html sends `x-admin-session` on every call and returns to login when the session expires. Migrations `20260927180000`, `20260927190000`, `20260927191000` all applied. Verified: anon now sees only instagram_posts, popups, 6 safe settings keys and the two public views; full Playwright QA on staging and meensha.in (desktop 1366 + mobile 360: all pages, add-to-cart hold/release, coupon, customer login, Razorpay contact step, invoice mismatch, admin login screen) passed before and after the lock. Owner login confirmed on 2026-09-28: admin.html logs in and all tabs load after the lock.
- 2026-09-27 (cloud routine, d3c8c82): `page_views` now logged on `/sarees/*` and product.html.
- 2026-09-27: `page_views` now logged on `/sarees/*` and `product.html` (was only `index.html`/`about.html`). Added the same write-only POST used on those two pages: `sarees/weave.js` (page `sarees`, covers all 15 `/sarees/<weave>/` pages that load it), `setup/build_weave_pages.py`'s `index_page()` template (page `sarees`, regenerated `sarees/index.html`), and `product.html` (page `product`). No new digest breakdown added — these just add to the existing daily/weekly totals in `visitStats()`.
- 2026-09-27: SEO audit (claude-seo, score 47/100) and fixes, commits f01e764 + c5ea425. Added 15 static `/sarees/<weave>/` landing pages plus `/sarees/`, and `product.html?id=` with Product schema. Homepage now has one H1, a new title, og-image and more schema. Page weight: homepage 30 MB → 3.2 MB (lab LCP 22.7 → 9.5 s), about.html 2.7 MB → 35 KB HTML. The rotating logo GIF became WebP and the hero PNGs became WebP. The 54 product photos in storage were re-encoded (404 MB → 17 MB, originals in `Meensha/backups/item-photos-originals-2026-09-27/`). Uploads now compress to 1200px. Enforce HTTPS turned on via the GitHub API. Fixed an about.html TDZ error (it had stopped about-page view counting and the ticker) and horizontal overflow. QA subagent on staging: all PASS, no regressions.
- 2026-09-27: Fixed category-page indexing — GSC's Page Indexing report showed the 15 `?shop=<term>` sitemap URLs as "Alternative page with proper canonical tag" (2) and part of "Discovered — currently not indexed" (16), because `index.html` had a static canonical/title/description pointing at the bare homepage regardless of query string, so every category URL was telling Google to index the homepage instead of itself. Added `updateMetaForShopTerm()` — sets canonical/title/description/OG/twitter tags dynamically per term. Weaker than server-rendering, but a strict improvement; verified live via JS check against `?shop=Mangalgiri` on both staging and production. Real indexing improvement (if any) won't show in GSC for some days — worth checking alongside the scheduled 2026-09-22 GSC reminder follow-up.
- 2026-09-15: Fixed sale `MSH-1040` (Abhilasha, 2026-08-30) showing a false ₹670 balance-due — payment was actually final, the gap was an unrecorded extra discount. Corrected `total`/`balance` and regenerated the cached invoice PDF (now shows "Additional Discount −₹670", "Fully Paid"); no code bug, `generate-invoice-pdf` already had this gap-detection built in. Checked the full `sales` table (India + Oz share one table) — no other sale currently has a stale balance.
- 2026-09-15: sitemap.xml now lists the 15 saree-type shop category pages (`?shop=<term>`) from the clean keyword list mined in Phase 2 (Ajrakh, Bandhani, Batik, Chiffon, Dola, Georgette, Kalamkari, Katan, Khaddi, Kota Doria, Madhubani, Mangalgiri, Modal, Mothra, Muga) — confirmed `?shop=` does a substring search (`matchSearch()` in index.html) so these terms will actually surface matching SKUs. Per-SKU product-page entries deliberately left out — no stable per-product URL exists yet (`?buy=<sku_id>` just adds to cart) and the SKU set changes too often for a static sitemap entry per item.
- 2026-09-14: Applied the daily-digest formatting notes to `daily-health-check`'s Telegram message: swapped the ⚠️ header icon for 📋 (was overloaded — ⚠️ is also used to detect warning content inside the report body), and changed the no-photo item list from comma-joined to one bullet per line.
- 2026-09-13: New "Content Drafts" tab in admin.html — fetches raw `.md` files listed in a hardcoded `DRAFT_FILES` array (currently `docs/MEDIUM_POST_02_draft.md`, `docs/ARTISANS_BLOG_DRAFT_01.md`), renders them with a small dependency-free markdown-to-HTML helper (`mdToHtml`), and gives each a Copy-to-clipboard button so Dheeraj can review/copy-paste into Medium or the Artisans section without digging through the repo. Confirmed `docs/*.md` is actually served at the live meensha.in URL (no Jekyll conversion — `curl -I https://meensha.in/docs/README.md` returns `200 text/markdown`), so the same relative-fetch pattern works in production. To add a future draft: just append `{file:'docs/...', label:'...'}` to `DRAFT_FILES`.
- 2026-09-13: "NEW" (added to `inventory_skus` within 14 days, via `created_at`) and "Trending" product image badges on the storefront shop grid (`index.html`'s `renderShopGrid`). Trending is a staff-set flag (new `inventory_skus.trending` column, migration `20260913140000`) toggled in admin.html's Inventory tab, with a suggestion nudge (💡) when a SKU has ≥3 units sold in the last 14 days (computed from existing `inventory_units` sold/updated_at data) — staff can accept or ignore; the toggle is always the final word. Instagram view-count half of the suggestion signal not built (see Queued above — blocked on Meta API access).
- 2026-09-13: Confirmed the `?shop=`/`?buy=` deep links already pass through extra UTM params (`utm_source`, `utm_medium`, etc.) safely — both use `URLSearchParams(location.search).get(...)`, which ignores unrelated keys. No code change needed.
- 2026-09-13: Kiosk "Share links/photos" (renamed from "Share this search") now offers two options: the existing filtered `?shop=` link, or a new flow that sends individual WhatsApp-ready messages per selected item (numbered list → multi-select → customer name → include-price choice → each item as its own photo+price+greeting+`?buy=` link, no wrapper text) — `supabase/functions/telegram-bot/index.ts`. Deployed (`--no-verify-jwt` confirmed held) and QA-verified against live code; still needs one live Telegram tap-through test by a human — no agent has actually messaged the bot.
- 2026-09-13: Admin login attempts now log real IP + geolocation per attempt (new `log-auth-attempt` Edge Function; admin.html's Auth Log card already had unbounded history, now with IP/Location columns) and a new `auth-log-digest` cron posts a rolling since-last-report summary to MeenshaMonitor only, never Shalini's chat. Deployed and verified live — also fixed a real pre-existing bug found along the way: the `auth_log` table never existed, so every login-attempt insert since 26 Jun 2026 was silently swallowed by a try/catch. Table now created with matching RLS.
- 2026-09-13: "📝 Content Drafts" tab added to admin.html — lists blog/content drafts from `docs/` (currently the Medium series post #2 draft and the Artisans-section weaver-upliftment draft), rendered readably with a one-click Copy button per draft. Confirmed `docs/*.md` is actually served live by GitHub Pages (not just assumed).
- 2026-09-13: Deleted two stale, non-git-tracked snapshot directories from the parent folder (`Build M1 M2/`, `files-5/`, both pre-dating current migrations) after review — see `STAGING_SEPARATION_PROPOSAL.md` for the fuller repo-consolidation writeup.
- 2026-09-13: Admin login page — Meensha logo now links back to index.html (was a dead image, staff had no way back to the main site from the login screen).
- 2026-09-18: TODO.md housekeeping — the "Connect GitHub + create Meensha TODO worker routine" item was marked `[x]` done (live since 2026-09-13, `trig_01CSksr3xMEajpixfNFjgj3g`) but left sitting in the Queued section; moved it here where it belongs. No code change.
- 2026-09-13: Connected GitHub and created the "Meensha TODO worker" routine (`trig_01CSksr3xMEajpixfNFjgj3g`) — meensha-test2 (staging) only, reports to Shalini + MeenshaMonitor via `agent-report`. Fires at 08:30, 12:30, 16:30, 20:30, 00:30, 04:30 IST, daily rollup on the 08:30 IST run. https://claude.ai/code/routines/trig_01CSksr3xMEajpixfNFjgj3g
- 2026-09-13: Dynamic shop categories + live search + kiosk "Share this search" link; fixed deep-link scroll target and mobile category/grid overlap.
- 2026-09-13: Daily health digest now also flags SKUs with no photos, sent to Shalini's chat too (was monitor-only).
- 2026-09-12: AU stock-intake pending-cost tracking; fixed a serious region-awareness bug in the real (previously-dead-code-shadowed) approval function.
- 2026-09-11/12: Invoice PDF generation (pdf-lib), backfilled for all historical sales; fixed a 100%-reproducing ₹-symbol encoding bug; static UPI QR feature; Razorpay customer-record linking.
