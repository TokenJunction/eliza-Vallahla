/* Public site settings. These are not secrets.
   The live Pro checkout is the $9.99/mo launch price.
   Yearly and Lifetime stay hidden until their URLs are pasted here. */
window.VALHALLA_SITE = {
  formspree: "",
  googleForm: "",
  x: "",
  discord: "",
  telegram: "",
  adsense: false,
  ADSENSE_CLIENT: "ca-pub-6504655762357230",
  adsenseClient: "ca-pub-6504655762357230",
  SIGNED_IN_EMAIL: "",
  TRIAL_DAYS: 15,
  PRO_PRICE: "$9.99/mo launch price",
  LEMONSQUEEZY_CHECKOUT_URL: "https://valhalla.lemonsqueezy.com/checkout/buy/4f959b69-81ca-45ca-8c3d-c80347b6b439",
  LEMONSQUEEZY_YEARLY_URL: "",
  LEMONSQUEEZY_LIFETIME_URL: "",
  CHROME_WEB_STORE_URL: "",
  /* Paste the Brain API click address when the worker hostname is live. Example: https://YOUR-WORKER/v1/offers/click */
  OFFER_CLICK_URL: "",
  BRAIN_URL: "",
  handle: "@ValhallaOS",
  xUrl: "https://x.com/intent/user?user_id=2092719999886475265",
  dmUrl: "https://x.com/messages/compose?recipient_id=2092719999886475265",
  /* Public Turnstile site key for hostname valhalla-app.xyz. The secret stays in the Worker. */
  TURNSTILE_SITE_KEY: "0x4AAAAAAFygFBUewoXH7oRO",
  /* Live Worker valhalla-turnstile-verify. POST {token} returns {success, ok}. */
  TURNSTILE_VERIFY_URL: "https://valhalla-turnstile-verify.valhalla-app.workers.dev/api/verify",
  /* Public Google OAuth web client. Origins: https://valhalla-app.xyz and https://www.valhalla-app.xyz. Scopes: openid, email, profile. */
  GOOGLE_CLIENT_ID: "1085862906383-cmiqc9bu96uqigm73nb3jkp5vfjf9b7l.apps.googleusercontent.com",
  /* Optional email sign-in Worker. POST {email}. Leave empty until that Worker exists. */
  MAGIC_LINK_URL: "",
  /* Live sign-in Worker valhalla-auth: Google token check and the emailed 6-digit code. */
  AUTH_URL: "https://valhalla-auth.valhalla-app.workers.dev",
  /* Paste the live Spring store URL before any buy button is enabled. */
  SPRING_STORE_URL: "",
  /* Merch card. Leave enabled false until shop.url is a live https store. */
  shop: {
    url: "",
    code: "VALHALLA25",
    enabled: false
  },
  /* Empty until the analysis API is deployed. Leader mode stays off while this is empty. */
  AGENT_API_URL: "",
  /* Public status only. Leave empty until the keeper is deployed. An empty value must show Status unavailable. */
  STATUS_URL: "",
  /* Leader turns the Hive on from the API. The site stays off while this is false. */
  HIVE_ENABLED: false,
  HIVE_URL: "",
  /* Payouts stay off. Points have no cash value and no public rate. */
  REWARDS_PAYOUT_ENABLED: false,
  /* Terms clickwrap. A new value asks again. */
  TERMS_VERSION: "2026-11-03",
  /* Empty until a Coinbase Commerce or NOWPayments checkout URL exists. */
  COINBASE_COMMERCE_URL: "",
  NOWPAYMENTS_URL: "",
  /* Live-money trading stays off until TokenJunction turns this on. */
  LIVE_TRADING: false,
  /* Quote uses GET /api/jupiter/quote only when this is true and AGENT_API_URL is https. Submit is not mounted. */
  TRADING_ENABLED: false,
  /* Thales uses the OpenAI chat Worker; credentials remain server-side Cloudflare secrets. */
  CHAT_URL: "https://valhalla-chat.valhalla-app.workers.dev",
  /* Cached public price Worker. Empty until it is deployed. The ticker hides if this is empty. */
  TICKER_URL: ""
};
