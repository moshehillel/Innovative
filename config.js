// Innovative Carriers quote dashboard — single-tenant config.
window.QUOTE_DASHBOARD_CONFIG = {
  name: "Innovative Carriers",
  // Same-origin proxy (see netlify.toml). The browser never calls Cloud
  // Functions directly, so a strict CORS header on an old function cannot
  // block the dashboard.
  functionsBaseUrl: "/fn",
  tenantId: "default",
};
