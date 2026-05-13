import { ConfigService } from "@nestjs/config";

export function getJwtSecret(config: ConfigService, key: "JWT_ACCESS_SECRET" | "JWT_REFRESH_SECRET", fallback: string) {
  const secret = config.get<string>(key);
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error(`${key} must be configured in production`);
  }
  return secret ?? fallback;
}
