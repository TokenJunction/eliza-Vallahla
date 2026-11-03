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
  /* Google OAuth web client. Authorized JavaScript origin: https://valhalla-app.xyz */
  GOOGLE_CLIENT_ID: "GOOGLE_CLIENT_ID_NOT_SET",
  /* Paste the live Spring store URL before any buy button is enabled. */
  SPRING_STORE_URL: ""
};
