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
  /* Paste the Turnstile site key for hostname valhalla-app.xyz. Leave the placeholder until it exists. */
  TURNSTILE_SITE_KEY: "TURNSTILE_SITE_KEY_NOT_SET",
  /* Worker route. The secret TURNSTILE_SECRET stays in Cloudflare, never in this file. */
  TURNSTILE_VERIFY_URL: "https://valhalla-app.xyz/api/verify",
  /* Google OAuth web client. Authorized JavaScript origin: https://valhalla-app.xyz */
  GOOGLE_CLIENT_ID: "GOOGLE_CLIENT_ID_NOT_SET"
};
