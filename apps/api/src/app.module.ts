import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AnnotationsModule } from "./modules/annotations/annotations.module";
import { AuthModule } from "./modules/auth/auth.module";
import { FilesModule } from "./modules/files/files.module";
import { HealthModule } from "./modules/health/health.module";
import { PrismaModule } from "./modules/prisma/prisma.module";
import { ReadingProgressModule } from "./modules/reading-progress/reading-progress.module";
import { RedisModule } from "./modules/redis/redis.module";
import { StorageModule } from "./modules/storage/storage.module";
import { SyncModule } from "./modules/sync/sync.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RedisModule,
    StorageModule,
    HealthModule,
    AuthModule,
    FilesModule,
    AnnotationsModule,
    ReadingProgressModule,
    SyncModule
  ]
})
export class AppModule {}
