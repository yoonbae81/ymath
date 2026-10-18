# Authentication boundary

## Current application behavior

The family app is anonymous. It has no application login, logout, cookie session, share link, guest mode, LAN identity, or Cloudflare Access check. Retired login, logout, share, and share-link routes return 410. Mutating browser requests require the same-origin `X-Requested-With: ymath` CSRF header. Private runner endpoints require the `RUNNER_TOKEN` bearer credential.

This is not a claim of private family access. Anyone who can reach a deployed app can read and change family records, photos, analyses, and feedback, upload or delete content, and trigger reanalysis. The R2 bucket stays private, with same-origin APIs proxying its objects.

Cloudflare Zero Trust is deferred to a separate deployment stage, to be configured by the user in Cloudflare. It is not required or implemented by the app runtime. No Access policy or Cloudflare resource was created or changed as part of local implementation.

When that policy is added, include a deliberate policy for the independent Node runner: a browser-only Access login in front of `/api/runner/*` would block its outbound polling. Use a separately approved Access service-auth policy/client configuration or a narrowly scoped runner-path policy; the application's `RUNNER_TOKEN` bearer check must remain enforced either way. No Access service credentials are configured in this change. Reference: [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).

## Historical implementation

An earlier implementation proposal validated Cloudflare Access JWTs and retained signed guest shares. The user superseded that authentication design: application login, Access integration, and sharing were removed in favor of an anonymous family app. Do not use the historical Access configuration or guest-share design as a current requirement.
