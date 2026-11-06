# FARQ — AI sales associate, shop-in-chat, admin dashboard

One page, split 50 / 50:

- **Left:** a chat with **Max, your in-store sales associate**. He asks what you're after, shows product cards (photos, prices, colours, sizes), handles objections, suggests matching items, and checks you out right in the chat. Type and get a text reply, or tap the mic and talk to get a spoken reply.
- **Right:** the 3D character. His eyes and head follow your cursor.
- **Bottom-right phone button:** the visitor leaves their details and the AI calls them (needs Twilio).
- **`/admin`:** a dashboard to follow purchases and ship them to buyers, manage products, and edit store info and the sales playbook.

## Run it

Double-click **`start.command`**. The store opens at http://localhost:3000 and the admin at http://localhost:3000/admin.

You only need [Node.js](https://nodejs.org) 22 or newer; there are no npm packages. The admin password is `ADMIN_PASSWORD` in `.env`. If that's empty, a password is generated on first run and saved in `data/admin-password.txt`.

## First steps

1. Open **/admin → Products** and replace the **sample products** (marked SAMPLE) with your real items. For each one: name, price, photos (upload or paste a URL), colours, sizes, stock per variant, selling points and tags. The salesperson only knows what's in this catalog.
2. Open **/admin → Store & AI** and fill in your brand story, shipping and return policies, and contact info. The salesperson only states these facts, so it never makes up policies.
3. Optionally edit the **Salesperson playbook** there: the selling style, techniques and tone.

## How buying works

1. The shopper chats, and Max shows product cards. They pick a colour and size and tap **Add to bag**, or just say "yes, add the medium" and Max adds it.
2. The bag (top-right of the chat) shows the items, quantities, total and progress toward free shipping.
3. **Checkout** opens a form for contact, address and payment:
   - **Pay later** (default): the order is saved and you arrange payment yourself. Mark it paid in the admin.
   - **Card**: add `STRIPE_SECRET_KEY` to `.env`. Shoppers then pay on Stripe's secure page and the order is marked **paid** automatically. Card details never touch this server or the chat.
4. The shopper gets an order confirmation in the chat, and can later ask "where's my order?" (order number plus email).

## Shipping orders (admin)

Go to **Orders → To ship**, select an order, then:

- **Start packing**, then **Mark as shipped…** and enter the carrier, tracking number and optional link.
- **Print packing slip**, which shows the ship-to address and items.
- **Email buyer**, which opens your email app with the tracking details already filled in.
- **Mark delivered**, **Mark paid**, **Cancel**, or add internal notes. Every change is logged in the order history.

New orders show a badge in the sidebar and a pop-up notice. The dashboard refreshes every 15 seconds.

## Use your own API

Nothing in the code needs to change. Set these in `.env` and restart.

**Your own AI (instead of OpenAI) for the chat:**
```
AI_BASE_URL=https://your-api.example.com/v1
AI_API_KEY=...
AI_CHAT_MODEL=your-model
```
It must accept OpenAI-style `POST /chat/completions` with `messages`, `tools` and `stream: true`, and stream OpenAI-style chunks back (including `tool_calls`). Voice (speech-to-text and text-to-speech) and phone calls still use `OPENAI_API_KEY`.

**Your own product catalog:**
```
CATALOG_API_URL=https://your-api.example.com/products
CATALOG_API_KEY=...        # optional, sent as "Authorization: Bearer …"
```
`GET` must return `[...]` or `{ "products": [...] }`, where each product looks like this:
```json
{
  "id": "hoodie-01", "name": "Logo Hoodie", "category": "Hoodies",
  "price": 89, "compareAtPrice": 110,
  "images": ["https://…/front.jpg", "https://…/back.jpg"],
  "description": "…", "highlights": ["450gsm cotton"], "tags": ["winter", "gift"],
  "colors": ["Black"], "sizes": ["S", "M", "L"],
  "variants": [{ "id": "hoodie-01-black-m", "color": "Black", "size": "M", "stock": 4 }],
  "active": true
}
```
The catalog is cached for 60 seconds. When it comes from your API, product editing in the admin is turned off and stock isn't changed locally.

## Live phone calls (Twilio)

1. Create a Twilio account and a phone number with Voice.
2. In `.env`, set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM_NUMBER`.
3. Set `PUBLIC_URL` to a public https address for this server, either your domain or a tunnel such as `cloudflared tunnel --url http://localhost:3000`.
4. Restart. The phone agent knows the catalog and store facts. To buy, it sends callers to the chat.

A Twilio trial account can only call numbers you've verified in the Twilio console.

## Files

```
start.command               double-click launcher (macOS)
server.js                   web server: shop API, admin API, voice, phone bridge
lib/ai.js                   AI provider (OpenAI or your own API)
lib/assistant.js            sales associate: prompt assembly, tools, tool loop
lib/catalog.js              products (local file or CATALOG_API_URL)
lib/commerce.js             bag, orders, settings, Stripe
lib/sample-products.js      placeholder catalog (replace it in /admin)
config/assistant-prompt.md  the sales playbook (also editable in /admin)
data/                       products.json, orders.json, settings.json, carts.json, leads.jsonl
public/index.html, js/, css/   storefront chat + 3D character
public/admin/               admin dashboard
public/uploads/             product photos uploaded in the admin
```

Back up the `data/` folder: it holds your orders and products.

## About the 3D eye tracking

The FBX rig has no eye bones and the eyes are painted into the texture. So the painted eyes are cut out with `public/models/textures/eye_mask.png`, and procedural 3D eyeballs with eyelids sit on new `eye_L` / `eye_R` bones attached to the head bone. They do saccades and pursuit, blink, and the lids follow the gaze. The head and neck take part of the turn. URL tuning: `?er=` eyeball radius, `?ei=` depth, `?lu=&ll=` lid openings, `?blink=1`, `?debug=1`.

## Knowledge API (your own FARQ model)

OpenAI stays the brain for chat, voice and phone calls. Your own API (built from FARQ's data) is plugged in as a **knowledge source**:

```
KNOWLEDGE_API_URL=https://model-api-production-2f90.up.railway.app
KNOWLEDGE_API_KEY=sk-...
KNOWLEDGE_TIMEOUT_MS=20000
```

- For factual FARQ questions (ingredients, usage, routine, brand, policies), the assistant calls `POST {KNOWLEDGE_API_URL}/v1/chat` and answers from its reply, in the sales voice. The live catalog still decides prices and what can be bought.
- Answers are cached for 30 minutes.
- If the API doesn't answer within the timeout or returns an error, the shop answers without it, skips the API for 3 minutes, then tries again. Shoppers never wait on a broken API.
- Phone calls use the same knowledge through a realtime tool.
- Check it: `GET /api/admin/knowledge` (stats), or `POST /api/admin/knowledge {"question":"…"}` (live test, admin login required).
