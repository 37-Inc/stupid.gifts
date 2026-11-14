// Nonsecret, owner-approved Access application. Only /api/content-admin/* is
// protected at the edge; the Worker independently validates this audience/email.
export const contentAdminSettings=Object.freeze({
  CONTENT_ADMIN_ENABLED:'true',
  CONTENT_ADMIN_TEAM_DOMAIN:'https://37-technology.cloudflareaccess.com',
  CONTENT_ADMIN_AUD:'ec7cc3e98c525fd0206536e459a7f0a83bec35c5af2b66fbdd7ccee85eec612c',
  CONTENT_ADMIN_STAFF_EMAILS:'cam@37.technology',
  // Staff additions wake the existing coordinator; no second publisher/clock.
  CONTENT_ADMIN_DISPATCH_ENABLED:'true',
});
