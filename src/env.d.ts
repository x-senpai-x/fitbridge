declare namespace Cloudflare {
  interface Env {
    // Compatibility secrets are optional, never required by the public setup.
    INGEST_SECRET?: string;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    OWNER_EMAIL?: string;
  }
}
interface Env extends Cloudflare.Env {}
