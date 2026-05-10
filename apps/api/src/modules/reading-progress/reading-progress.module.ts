import { Module } from "@nestjs/common";
import { ReadingProgressController } from "./reading-progress.controller";
import { ReadingProgressService } from "./reading-progress.service";

@Module({ controllers: [ReadingProgressController], providers: [ReadingProgressService] })
export class ReadingProgressModule {}
