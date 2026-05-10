import { HttpException, HttpStatus, Injectable, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(config: ConfigService) {
    this.client = new Redis(config.get<string>("REDIS_URL") ?? "redis://localhost:6379", {
      lazyConnect: true,
      maxRetriesPerRequest: 2
    });
  }

  async onModuleDestroy() {
    await this.client.quit();
  }

  async limit(key: string, maxRequests: number, windowSeconds: number) {
    const count = await this.client.incr(key);
    if (count === 1) await this.client.expire(key, windowSeconds);
    if (count > maxRequests) throw new HttpException("Too many requests. Please try again later.", HttpStatus.TOO_MANY_REQUESTS);
  }
}
