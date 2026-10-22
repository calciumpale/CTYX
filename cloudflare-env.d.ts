declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    MODEL_API_KEY?: string;
    MODEL_BASE_URL?: string;
    MODEL_NAME?: string;
    CONFIG_ENCRYPTION_KEY?: string;
    VOICE_GATEWAY_URL?: string;
    VOICE_GATEWAY_SECRET?: string;
  }
}
